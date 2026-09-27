const express = require('express');
const fs = require('fs');
const path = require('path');

let AdmZip = null;
let xml2js = null;
try {
    AdmZip = require('adm-zip');
    xml2js = require('xml2js');
} catch (e) {
    console.log('[안내] adm-zip 또는 xml2js 미설치 상태');
}

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'kospi_cache.json');

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'stock_management_system_krx.html'));
});

const FETCH_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

function parseFinNumber(valStr) {
    if (!valStr) return null;
    let s = valStr.replace(/,/g, '').trim();
    if (s === '' || s === '-' || s === 'N/A') return null;
    if (s.startsWith('(') && s.endsWith(')')) {
        s = '-' + s.slice(1, -1);
    }
    const num = parseFloat(s);
    return isNaN(num) ? null : num;
}

function isPureStock(item) {
    const name = item.stockName || item.name || '';
    const code = item.itemCode || item.code || '';
    if (/[0-9][0-9][0-9][0-9][0-9][1-9A-Z]$/.test(code)) return false;
    const excludeKeywords = ['스팩', '우', '우B', '우C', '리츠', 'ETF', 'ETN', '인프라', '펀드', '투융자'];
    for (const kw of excludeKeywords) {
        if (name.endsWith(kw) || name.includes(kw + ' ') || name.includes(' ' + kw)) return false;
    }
    return true;
}

function parseWiseReportHtml(html) {
    const years = [];
    const theadMatch = /<thead[^>]*>([\s\S]*?)<\/thead>/i.exec(html);
    if (theadMatch) {
        const trs = theadMatch[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
        if (trs.length > 0) {
            const lastTr = trs[trs.length - 1];
            const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi;
            let m;
            while ((m = thRegex.exec(lastTr)) !== null) {
                const txt = m[1].replace(/<[^>]+>/g, '').trim();
                if (txt && !txt.includes('주요재무') && !txt.includes('IFRS')) {
                    years.push(txt);
                }
            }
        }
    }

    const rowData = {};
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;
    while ((trMatch = trRegex.exec(html)) !== null) {
        const trContent = trMatch[1];
        const thMatch = /<th[^>]*>([\s\S]*?)<\/th>/i.exec(trContent);
        if (!thMatch) continue;
        const title = thMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim();

        const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let tdMatch;
        const vals = [];
        while ((tdMatch = tdRegex.exec(trContent)) !== null) {
            vals.push(tdMatch[1].replace(/<[^>]+>/g, '').trim());
        }
        if (title && vals.length > 0) {
            rowData[title] = vals;
        }
    }

    return { years, rowData };
}

// 1. KOSPI 수집
app.get('/api/sync-krx', async (req, res) => {
    try {
        console.log('[KOSPI] 종목 수집 시작...');
        let page = 1;
        let allStocks = [];
        while (true) {
            const url = `https://m.stock.naver.com/api/stocks/marketValue/KOSPI?page=${page}&pageSize=100`;
            const resp = await fetch(url, { headers: FETCH_HEADERS });
            const data = await resp.json();
            const list = data.stocks || [];
            if (!list || list.length === 0) break;

            for (const s of list) {
                if (isPureStock(s)) {
                    allStocks.push({
                        code: s.itemCode,
                        name: s.stockName,
                        price: parseFinNumber(s.closePrice),
                        changeRate: parseFinNumber(s.fluctuationsRatio),
                        marketCap: parseFinNumber(s.marketValue),
                        latestSales: null,
                        latestNetIncome: null,
                        opm: null,
                        isContinuousGrowth: false,
                        ocfQuality: false,
                        per: null,
                        pbr: null,
                        roe: null,
                        fcf: null,
                        fcfYield: null,
                        salesGrowth: null,
                        netIncomeGrowth: null,
                        debtRatio: null,
                        ocf: null,
                        peg: null,
                        dividendYield: null,
                        dividendPayout: null
                    });
                }
            }
            if (list.length < 100) break;
            page++;
        }

        if (fs.existsSync(CACHE_FILE)) {
            try {
                const oldCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
                const oldMap = new Map(oldCache.map(x => [x.code, x]));
                allStocks = allStocks.map(ns => {
                    const os = oldMap.get(ns.code);
                    if (os) {
                        return {
                            ...ns,
                            latestSales: os.latestSales,
                            latestNetIncome: os.latestNetIncome,
                            opm: os.opm,
                            isContinuousGrowth: os.isContinuousGrowth,
                            ocfQuality: os.ocfQuality,
                            per: os.per,
                            pbr: os.pbr,
                            roe: ns.roe || os.roe,
                            fcf: os.fcf,
                            fcfYield: os.fcfYield,
                            salesGrowth: os.salesGrowth,
                            netIncomeGrowth: os.netIncomeGrowth,
                            debtRatio: os.debtRatio,
                            ocf: os.ocf,
                            peg: os.peg,
                            dividendYield: os.dividendYield,
                            dividendPayout: os.dividendPayout
                        };
                    }
                    return ns;
                });
            } catch (e) { }
        }

        fs.writeFileSync(CACHE_FILE, JSON.stringify(allStocks, null, 2), 'utf8');
        res.json({ success: true, count: allStocks.length, data: allStocks });
    } catch (err) {
        console.error('[KOSPI 수집 실패]', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. WiseReport 퀀트 재무 수집 (체급 및 3개년 연속 성장 분석)
app.post('/api/sync-wisereport-batch', async (req, res) => {
    const { stocks } = req.body;
    if (!stocks || !Array.isArray(stocks)) {
        return res.status(400).json({ success: false, message: 'stocks 배열 필요' });
    }

    const results = await Promise.all(stocks.map(async (stk) => {
        try {
            const url = `https://navercomp.wisereport.co.kr/v2/company/cF1001.aspx?cmp_cd=${stk.code}&fin_typ=0&freq_typ=Y`;
            const resp = await fetch(url, {
                headers: FETCH_HEADERS,
                signal: AbortSignal.timeout(7000)
            });
            const text = await resp.text();
            const { rowData } = parseWiseReportHtml(text);

            const getAllValues = (candidateKeys) => {
                for (const key of candidateKeys) {
                    const matchedRow = Object.keys(rowData).find(k => k.includes(key));
                    if (matchedRow) {
                        return rowData[matchedRow].map(parseFinNumber).filter(v => v !== null);
                    }
                }
                return [];
            };

            const salesVals = getAllValues(['매출액']);
            const netVals = getAllValues(['당기순이익']);
            const opVals = getAllValues(['영업이익']);
            const debtVals = getAllValues(['부채비율']);
            const ocfVals = getAllValues(['영업활동으로인한현금흐름', '영업활동']);
            const fcfVals = getAllValues(['FCF']);
            const perVals = getAllValues(['PER']);
            const pbrVals = getAllValues(['PBR']);
            const roeVals = getAllValues(['ROE']);
            const divYieldVals = getAllValues(['현금배당수익률', '배당수익률', '시가배당률']);
            const divPayoutVals = getAllValues(['현금배당성향', '배당성향']);

            const latest = (arr) => arr.length > 0 ? arr[arr.length - 1] : null;
            const prev = (arr) => arr.length > 1 ? arr[arr.length - 2] : null;

            const latestSales = latest(salesVals);
            const prevSales = prev(salesVals);
            const latestNet = latest(netVals);
            const prevNet = prev(netVals);
            const latestOp = latest(opVals);
            const latestDebt = latest(debtVals);
            const latestOcf = latest(ocfVals);
            const latestFcf = latest(fcfVals);
            const latestPer = latest(perVals);
            const latestPbr = latest(pbrVals);
            const latestRoe = latest(roeVals);
            const latestDivYield = latest(divYieldVals);
            const latestDivPayout = latest(divPayoutVals);

            // 3개년 연속 성장(계단식 우상향) 판별
            const isSalesCont = salesVals.length >= 3 &&
                salesVals[salesVals.length - 1] > salesVals[salesVals.length - 2] &&
                salesVals[salesVals.length - 2] > salesVals[salesVals.length - 3];

            const isNetCont = netVals.length >= 3 &&
                netVals[netVals.length - 1] > netVals[netVals.length - 2] &&
                netVals[netVals.length - 2] > netVals[netVals.length - 3];

            const isContinuousGrowth = isSalesCont && isNetCont;

            // 현금 창출력 검증 (영업현금흐름 > 당기순이익)
            const ocfQuality = (latestOcf !== null && latestNet !== null && latestNet > 0) ? (latestOcf >= latestNet) : false;

            // 영업이익률 (%)
            let opm = null;
            if (latestOp !== null && latestSales !== null && latestSales > 0) {
                opm = parseFloat(((latestOp / latestSales) * 100).toFixed(2));
            }

            // 성장률 (%)
            let salesGrowth = null;
            if (latestSales !== null && prevSales !== null && prevSales > 0) {
                salesGrowth = parseFloat((((latestSales - prevSales) / prevSales) * 100).toFixed(2));
            }

            let netIncomeGrowth = null;
            if (latestNet !== null && prevNet !== null && Math.abs(prevNet) > 0) {
                netIncomeGrowth = parseFloat((((latestNet - prevNet) / Math.abs(prevNet)) * 100).toFixed(2));
            }

            // FCF 수익률 (%)
            let fcfYield = null;
            if (latestFcf !== null && stk.marketCap && stk.marketCap > 0) {
                fcfYield = parseFloat(((latestFcf / stk.marketCap) * 100).toFixed(2));
            }

            // PEG
            let peg = null;
            if (latestPer && latestPer > 0 && netIncomeGrowth && netIncomeGrowth > 0) {
                peg = parseFloat((latestPer / netIncomeGrowth).toFixed(2));
            }

            return {
                code: stk.code,
                latestSales,
                latestNetIncome: latestNet,
                opm,
                isContinuousGrowth,
                ocfQuality,
                per: latestPer,
                pbr: latestPbr,
                roe: latestRoe,
                fcf: latestFcf,
                fcfYield: fcfYield,
                salesGrowth: salesGrowth,
                netIncomeGrowth: netIncomeGrowth,
                debtRatio: latestDebt,
                ocf: latestOcf,
                peg: peg,
                dividendYield: latestDivYield,
                dividendPayout: latestDivPayout
            };
        } catch (e) {
            return { code: stk.code };
        }
    }));

    if (fs.existsSync(CACHE_FILE)) {
        try {
            const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            const resMap = new Map(results.map(r => [r.code, r]));
            const updated = cache.map(item => {
                const u = resMap.get(item.code);
                return u ? { ...item, ...u } : item;
            });
            fs.writeFileSync(CACHE_FILE, JSON.stringify(updated, null, 2), 'utf8');
        } catch (e) { }
    }

    res.json({ success: true, data: results });
});

// 3. DART ROE 수집 프록시
let corpCodeMapCache = null;
async function getDartCorpCode(apiKey, stockCode) {
    if (corpCodeMapCache && corpCodeMapCache.has(stockCode)) {
        return corpCodeMapCache.get(stockCode);
    }
    if (!AdmZip || !xml2js) return null;

    const zipUrl = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}`;
    const resp = await fetch(zipUrl, { signal: AbortSignal.timeout(15000) });
    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const zip = new AdmZip(buffer);
    const xmlEntry = zip.getEntries().find(e => e.entryName.endsWith('.xml'));
    if (!xmlEntry) return null;
    const xmlData = zip.readAsText(xmlEntry);
    const parsed = await xml2js.parseStringPromise(xmlData);
    const list = parsed.result.list;
    corpCodeMapCache = new Map();
    for (const item of list) {
        const sc = (item.stock_code[0] || '').trim();
        const cc = (item.corp_code[0] || '').trim();
        if (sc) corpCodeMapCache.set(sc, cc);
    }
    return corpCodeMapCache.get(stockCode) || null;
}

app.get('/api/dart-roe', async (req, res) => {
    const { apiKey, code, year } = req.query;
    if (!apiKey || !code) return res.status(400).json({ success: false, message: 'apiKey와 code 필요' });
    try {
        const corpCode = await getDartCorpCode(apiKey, code);
        if (!corpCode) return res.json({ success: false, roe: null });

        const targetYear = year || (new Date().getFullYear() - 1);
        const fnUrl = `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?crtfc_key=${apiKey}&corp_code=${corpCode}&bsns_year=${targetYear}&reprt_code=11011&fs_div=CFS`;
        const resp = await fetch(fnUrl, { signal: AbortSignal.timeout(8000) });
        const fnData = await resp.json();
        const list = fnData.list || [];

        let netIncome = null;
        let totalEquity = null;
        for (const it of list) {
            if (it.account_nm === '당기순이익' || it.account_id === 'ifrs-full_ProfitLoss') {
                netIncome = parseFinNumber(it.thstrm_amount);
            }
            if (it.account_nm === '자본총계' || it.account_id === 'ifrs-full_Equity') {
                totalEquity = parseFinNumber(it.thstrm_amount);
            }
        }
        let roe = null;
        if (netIncome !== null && totalEquity && totalEquity > 0) {
            roe = parseFloat(((netIncome / totalEquity) * 100).toFixed(2));
        }

        if (roe !== null && fs.existsSync(CACHE_FILE)) {
            try {
                const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
                const item = cache.find(x => x.code === code);
                if (item) {
                    item.roe = roe;
                    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
                }
            } catch (e) { }
        }

        res.json({ success: true, roe });
    } catch (err) {
        res.json({ success: false, roe: null, error: err.message });
    }
});

// 4. 실시간 심층 분석 HTML 리포트
app.get('/api/stock-report', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('종목코드가 필요합니다.');

    try {
        const [naverResp, wiseResp] = await Promise.all([
            fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, { headers: FETCH_HEADERS }),
            fetch(`https://navercomp.wisereport.co.kr/v2/company/cF1001.aspx?cmp_cd=${code}&fin_typ=0&freq_typ=Y`, {
                headers: FETCH_HEADERS,
                signal: AbortSignal.timeout(8000)
            })
        ]);

        const basic = await naverResp.json();
        const wiseHtml = await wiseResp.text();
        const { years, rowData } = parseWiseReportHtml(wiseHtml);

        const financialRows = [
            '매출액', '영업이익', '당기순이익', '영업활동으로인한현금흐름', '부채비율',
            'ROE(지배)', 'ROA', 'PER', 'PBR', 'EPS(원)', 'BPS(원)', '현금배당수익률', '현금배당성향(%)'
        ];

        const reportData = {};
        for (const f of financialRows) {
            const key = Object.keys(rowData).find(k => k.includes(f));
            if (key) reportData[f] = rowData[key];
        }

        const stockName = basic.stockName || code;
        const closePrice = basic.closePrice || '-';
        const marketCap = basic.marketValue ? (parseFinNumber(basic.marketValue) + ' 억 원') : '-';
        const per = basic.per || '-';
        const pbr = basic.pbr || '-';

        const yearsHeaderHtml = years.map(y => `<th>${y}</th>`).join('');
        const rowsHtml = Object.keys(reportData).map(k => {
            const tds = reportData[k].map(val => `<td>${val || '-'}</td>`).join('');
            return `<tr><td class="row-title">${k}</td>${tds}</tr>`;
        }).join('');

        const html = `
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <title>[분석리포트] ${stockName} (${code})</title>
    <style>
        :root { --primary: #2563eb; --bg: #f8fafc; --card: #ffffff; --text: #1e293b; --border: #e2e8f0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 30px; }
        .container { max-width: 1000px; margin: 0 auto; background: var(--card); padding: 32px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); }
        .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid var(--border); padding-bottom: 20px; margin-bottom: 24px; }
        .title h1 { margin: 0; font-size: 28px; color: #0f172a; display: flex; align-items: center; gap: 10px; }
        .code-badge { font-size: 14px; background: #e0e7ff; color: #3730a3; padding: 4px 10px; border-radius: 6px; }
        .btn-group { display: flex; gap: 10px; }
        .btn { padding: 8px 16px; border-radius: 8px; font-weight: 600; cursor: pointer; border: 1px solid var(--border); text-decoration: none; font-size: 13px; }
        .btn-primary { background: var(--primary); color: white; border: none; }
        .metrics-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 30px; }
        .metric-card { background: #f1f5f9; padding: 16px; border-radius: 10px; border-left: 4px solid var(--primary); }
        .metric-label { font-size: 12px; color: #64748b; margin-bottom: 6px; }
        .metric-val { font-size: 20px; font-weight: 700; color: #0f172a; }
        .section-title { font-size: 18px; font-weight: 700; margin: 24px 0 12px; color: #334155; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
        th, td { padding: 10px 14px; text-align: right; border-bottom: 1px solid var(--border); }
        th { background: #f8fafc; font-weight: 600; color: #475569; }
        td.row-title, th:first-child { text-align: left; font-weight: 600; background: #fafafa; }
        tr:hover { background: #f8fafc; }
        .footer { margin-top: 30px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 12px; color: #94a3b8; display: flex; justify-content: space-between; }
        @media print { .btn-group { display: none; } body { padding: 0; } .container { box-shadow: none; } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="title">
                <h1>${stockName} <span class="code-badge">${code}</span></h1>
                <p style="margin: 6px 0 0; color: #64748b; font-size: 13px;">기준일: ${new Date().toLocaleDateString('ko-KR')} 실시간 기업 가치 심층 분석</p>
            </div>
            <div class="btn-group">
                <button class="btn btn-primary" onclick="window.print()">🖨️ PDF / 인쇄</button>
                <a class="btn" href="https://finance.naver.com/item/main.naver?code=${code}" target="_blank">네이버증권 ↗</a>
            </div>
        </div>

        <div class="metrics-grid">
            <div class="metric-card"><div class="metric-label">현재가</div><div class="metric-val">${closePrice} 원</div></div>
            <div class="metric-card"><div class="metric-label">시가총액</div><div class="metric-val">${marketCap}</div></div>
            <div class="metric-card"><div class="metric-label">PER</div><div class="metric-val">${per} 배</div></div>
            <div class="metric-card"><div class="metric-label">PBR</div><div class="metric-val">${pbr} 배</div></div>
        </div>

        <div class="section-title">📊 최근 4개년 연간 재무 요약 (손익/재무/현금흐름)</div>
        <table>
            <thead><tr><th style="width: 220px;">주요 계정</th>${yearsHeaderHtml}</tr></thead>
            <tbody>${rowsHtml}</tbody>
        </table>

        <div class="footer">
            <span>데이터 출처: NAVER 금융 & WiseReport 컨센서스</span>
            <span>KOSPI 퀀트 스크리닝 자동생성 리포트</span>
        </div>
    </div>
</body>
</html>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (e) {
        res.status(500).send(`<h3>리포트 생성 오류: ${e.message}</h3>`);
    }
});

// 5. 캐시 조회
app.get('/api/cached-stocks', (req, res) => {
    if (fs.existsSync(CACHE_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            return res.json({ success: true, count: data.length, data });
        } catch (e) { }
    }
    res.json({ success: true, count: 0, data: [] });
});

app.listen(PORT, () => {
    console.log(`🚀 KOSPI 퀀트 발굴 서버 구동 완료: http://localhost:${PORT}`);
});