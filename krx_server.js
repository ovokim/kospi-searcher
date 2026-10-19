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
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

function parseFinNumber(valStr) {
    if (valStr === null || valStr === undefined) return null;
    let s = valStr.toString().replace(/,/g, '').trim();
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
            const thMatches = [...lastTr.matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi)];
            for (const m of thMatches) {
                const txt = m[2].replace(/<[^>]+>/g, '').trim();
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
        const cells = [...trContent.matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi)];
        if (cells.length < 2) continue;

        const title = cells[0][2].replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim();
        const vals = cells.slice(1).map(c => c[2].replace(/<[^>]+>/g, '').trim());

        if (title && vals.length > 0) {
            rowData[title] = vals;
        }
    }

    return { years, rowData };
}

// ⭐ [c1070001.aspx 전용] 국민연금 지분율 및 1W(2주 여유) / 1M / 3M 기간별 변동 파서
function parseNpsShareholding(shareHtml) {
    let npsRatio = null;
    let npsChange1W = null;
    let npsChange1M = null;
    let npsChange3M = null;

    if (!shareHtml || !shareHtml.includes('국민연금')) {
        return { npsRatio, npsChange1W, npsChange1M, npsChange3M };
    }

    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;
    const npsRows = [];

    while ((trMatch = trRegex.exec(shareHtml)) !== null) {
        const tr = trMatch[1];
        if (tr.includes('국민연금')) {
            const cells = [...tr.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
                .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim());
            npsRows.push(cells);
        }
    }

    if (npsRows.length === 0) {
        return { npsRatio: null, npsChange1W: null, npsChange1M: null, npsChange3M: null };
    }

    // 1. 현재 국민연금 보유지분율(npsRatio) 추출
    for (const cells of npsRows) {
        for (let i = 0; i < cells.length; i++) {
            const num = parseFinNumber(cells[i]);
            if (num !== null && num > 0 && num <= 100 && cells[i].includes('.')) {
                if (npsRatio === null || (cells.length <= 4 && num > npsRatio)) {
                    npsRatio = num;
                }
            }
        }
    }

    // 2. 1W(14일 여유), 1M(35일), 3M(100일) 기간별 변동 합산
    const now = new Date();
    const twoWeeksAgo = new Date(now.getTime() - (14 * 24 * 60 * 60 * 1000)); // 1W -> 14일로 보정
    const oneMonthAgo = new Date(now.getTime() - (35 * 24 * 60 * 60 * 1000));
    const threeMonthsAgo = new Date(now.getTime() - (100 * 24 * 60 * 60 * 1000));

    let total1W = 0, has1W = false;
    let total1M = 0, has1M = false;
    let total3M = 0, has3M = false;

    for (const cells of npsRows) {
        let tradeDate = null;
        let dateIdx = -1;

        for (let i = 0; i < cells.length; i++) {
            const m = cells[i].match(/^(\d{2,4})[\/.-](\d{2})[\/.-](\d{2})$/);
            if (m) {
                let y = parseInt(m[1], 10);
                if (y < 100) y += 2000;
                const mo = parseInt(m[2], 10) - 1;
                const d = parseInt(m[3], 10);
                tradeDate = new Date(y, mo, d);
                dateIdx = i;
                break;
            }
        }

        if (tradeDate && dateIdx !== -1) {
            let rowChange = null;
            for (let i = 0; i < cells.length; i++) {
                if (i === dateIdx) continue;
                const text = cells[i];
                if (/^[+-]?\d+(\.\d+)?%?$/.test(text)) {
                    const val = parseFinNumber(text);
                    if (val !== null && Math.abs(val) > 0 && Math.abs(val) <= 15) {
                        if (val !== npsRatio) {
                            rowChange = val;
                            break;
                        }
                    }
                }
            }

            if (rowChange !== null) {
                if (tradeDate >= twoWeeksAgo) {
                    total1W += rowChange;
                    has1W = true;
                }
                if (tradeDate >= oneMonthAgo) {
                    total1M += rowChange;
                    has1M = true;
                }
                if (tradeDate >= threeMonthsAgo) {
                    total3M += rowChange;
                    has3M = true;
                }
            }
        }
    }

    npsChange1W = has1W ? parseFloat(total1W.toFixed(2)) : 0;
    npsChange1M = has1M ? parseFloat(total1M.toFixed(2)) : 0;
    npsChange3M = has3M ? parseFloat(total3M.toFixed(2)) : 0;

    return { npsRatio, npsChange1W, npsChange1M, npsChange3M };
}

// 1. 보통주 수집
app.get('/api/sync-krx', async (req, res) => {
    const targetMarket = (req.query.market || 'ALL').toUpperCase();
    try {
        console.log(`[시장 수집 시작] 대상: ${targetMarket}`);
        const markets = targetMarket === 'ALL' ? ['KOSPI', 'KOSDAQ'] : [targetMarket];
        let allStocks = [];

        for (const mkt of markets) {
            let page = 1;
            while (true) {
                const url = `https://m.stock.naver.com/api/stocks/marketValue/${mkt}?page=${page}&pageSize=100`;
                const resp = await fetch(url, { headers: FETCH_HEADERS });
                const data = await resp.json();
                const list = data.stocks || [];
                if (!list || list.length === 0) break;

                for (const s of list) {
                    if (isPureStock(s)) {
                        allStocks.push({
                            code: s.itemCode,
                            name: s.stockName,
                            market: mkt,
                            subSector: null,
                            npsRatio: null,
                            npsChange1W: null,
                            npsChange1M: null,
                            npsChange3M: null,
                            foreignRatio: null,
                            foreignChange: null,
                            price: parseFinNumber(s.closePrice),
                            changeRate: parseFinNumber(s.fluctuationsRatio),
                            marketCap: parseFinNumber(s.marketValue),
                            latestSales: null,
                            latestNetIncome: null,
                            opm: null,
                            isContinuousGrowth: false,
                            ocfQuality: false,
                            high52: null,
                            low52: null,
                            high52Ratio: null,
                            ma60: null,
                            ma120: null,
                            return3M: null,
                            isUptrend: false,
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
                            dividendPayout: null,
                            quantScore: null
                        });
                    }
                }
                if (list.length < 100) break;
                page++;
            }
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
                            subSector: os.subSector || null,
                            npsRatio: os.npsRatio ?? null,
                            npsChange1W: os.npsChange1W ?? null,
                            npsChange1M: os.npsChange1M ?? null,
                            npsChange3M: os.npsChange3M ?? null,
                            foreignRatio: os.foreignRatio ?? null,
                            foreignChange: os.foreignChange ?? null,
                            latestSales: os.latestSales,
                            latestNetIncome: os.latestNetIncome,
                            opm: os.opm,
                            isContinuousGrowth: os.isContinuousGrowth,
                            ocfQuality: os.ocfQuality,
                            high52: os.high52,
                            low52: os.low52,
                            high52Ratio: os.high52Ratio,
                            ma60: os.ma60,
                            ma120: os.ma120,
                            return3M: os.return3M,
                            isUptrend: os.isUptrend,
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
                            dividendPayout: os.dividendPayout,
                            quantScore: os.quantScore
                        };
                    }
                    return ns;
                });
            } catch (e) { }
        }

        fs.writeFileSync(CACHE_FILE, JSON.stringify(allStocks, null, 2), 'utf8');
        res.json({ success: true, count: allStocks.length, data: allStocks });
    } catch (err) {
        console.error('[시장 수집 실패]', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. 퀀트 재무 + 차트(외인 지분/증감) + WICS & 국민연금 수급(1W, 1M, 3M) 수집
app.post('/api/sync-wisereport-batch', async (req, res) => {
    const { stocks, fastMode } = req.body;
    if (!stocks || !Array.isArray(stocks)) {
        return res.status(400).json({ success: false, message: 'stocks 배열 필요' });
    }

    const results = await Promise.all(stocks.map(async (stk) => {
        try {
            const chartJsonUrl = `https://fchart.stock.naver.com/siseJson.naver?symbol=${stk.code}&requestType=0&count=130&timeframe=day`;
            const wiseFinUrl = `https://navercomp.wisereport.co.kr/v2/company/cF1001.aspx?cmp_cd=${stk.code}&fin_typ=0&freq_typ=Y`;
            const wiseShareUrl = `https://navercomp.wisereport.co.kr/v2/company/c1070001.aspx?cmp_cd=${stk.code}`;

            const needFin = !(fastMode && stk.latestSales !== null && stk.latestSales !== undefined);
            const needShare = !stk.subSector || stk.subSector === '기타' || stk.npsRatio === null || stk.npsChange3M === null || !fastMode;

            const fetchTasks = [
                fetch(chartJsonUrl, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(7000) })
            ];
            if (needFin) {
                fetchTasks.push(fetch(wiseFinUrl, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(7000) }));
            }
            if (needShare) {
                fetchTasks.push(fetch(wiseShareUrl, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(7000) }));
            }

            const responses = await Promise.all(fetchTasks);
            const chartRawText = await responses[0].text();
            
            let idx = 1;
            const wiseFinText = needFin && responses[idx] ? await responses[idx++].text() : null;
            const shareText = needShare && responses[idx] ? await responses[idx++].text() : null;

            // WICS 세부종류 파싱
            let subSector = (stk.subSector && stk.subSector !== '기타') ? stk.subSector : null;
            if (shareText) {
                const wicsMatch = /WICS\s*:\s*([^<\r\n\t&;,.]+)/i.exec(shareText);
                if (wicsMatch && wicsMatch[1]) {
                    subSector = wicsMatch[1].replace(/&nbsp;/g, '').trim();
                }
            }
            if (!subSector) subSector = stk.subSector || '기타';

            // ⭐ 국민연금 지분율 및 1W / 1M / 3M 기간별 변동 파싱
            let npsRatio = stk.npsRatio ?? null;
            let npsChange1W = stk.npsChange1W ?? null;
            let npsChange1M = stk.npsChange1M ?? null;
            let npsChange3M = stk.npsChange3M ?? null;
            if (shareText) {
                const npsData = parseNpsShareholding(shareText);
                npsRatio = npsData.npsRatio;
                npsChange1W = npsData.npsChange1W;
                npsChange1M = npsData.npsChange1M;
                npsChange3M = npsData.npsChange3M;
            }

            // 일봉 시세 & 외국인 지분율 및 당일 증감 계산
            let high52 = null, low52 = null, high52Ratio = null, ma60 = null, ma120 = null, return3M = null, isUptrend = false;
            let foreignRatio = stk.foreignRatio ?? null;
            let foreignChange = stk.foreignChange ?? null;

            try {
                const cleanJsonStr = chartRawText
                    .replace(/\r?\n|\r/g, '')
                    .replace(/\s+/g, ' ')
                    .replace(/'/g, '"')
                    .trim();

                const chartData = JSON.parse(cleanJsonStr);
                const rows = chartData.filter(r => Array.isArray(r) && r.length >= 7 && /^\d{8}$/.test(r[0].toString().trim()));

                if (rows.length > 0) {
                    const highs = rows.map(r => parseFloat(r[2])).filter(v => !isNaN(v));
                    const lows = rows.map(r => parseFloat(r[3])).filter(v => !isNaN(v));
                    const closes = rows.map(r => parseFloat(r[4])).filter(v => !isNaN(v));

                    if (highs.length > 0) high52 = Math.max(...highs);
                    if (lows.length > 0) low52 = Math.min(...lows);

                    const curPrice = stk.price || (closes.length > 0 ? closes[closes.length - 1] : 0);
                    if (high52 && curPrice > 0) high52Ratio = parseFloat(((curPrice / high52) * 100).toFixed(1));

                    if (closes.length >= 60) {
                        const last60 = closes.slice(-60);
                        ma60 = Math.round(last60.reduce((a, b) => a + b, 0) / 60);
                        const base60 = closes[closes.length - 60];
                        if (base60 > 0) return3M = parseFloat((((curPrice - base60) / base60) * 100).toFixed(2));
                    }
                    if (closes.length >= 120) {
                        const last120 = closes.slice(-120);
                        ma120 = Math.round(last120.reduce((a, b) => a + b, 0) / 120);
                    }
                    if (curPrice > 0 && ma60) {
                        isUptrend = curPrice >= ma60 && (!ma120 || curPrice >= ma120);
                    }

                    const validFrgnRows = rows.filter(r => !isNaN(parseFloat(r[6])));
                    if (validFrgnRows.length >= 2) {
                        const curFrgn = parseFloat(validFrgnRows[validFrgnRows.length - 1][6]);
                        foreignRatio = parseFloat(curFrgn.toFixed(2));

                        let diff = curFrgn - parseFloat(validFrgnRows[validFrgnRows.length - 2][6]);
                        if (Math.abs(diff) < 0.001) {
                            for (let k = validFrgnRows.length - 3; k >= Math.max(0, validFrgnRows.length - 6); k--) {
                                const pastDiff = curFrgn - parseFloat(validFrgnRows[k][6]);
                                if (Math.abs(pastDiff) >= 0.01) {
                                    diff = pastDiff;
                                    break;
                                }
                            }
                        }
                        foreignChange = parseFloat(diff.toFixed(2));
                    } else if (validFrgnRows.length === 1) {
                        foreignRatio = parseFloat(parseFloat(validFrgnRows[0][6]).toFixed(2));
                        foreignChange = 0;
                    }
                }
            } catch (err) { }

            let finData = {};
            if (wiseFinText) {
                const { rowData } = parseWiseReportHtml(wiseFinText);
                const getAllValues = (candidateKeys) => {
                    for (const key of candidateKeys) {
                        const matchedRow = Object.keys(rowData).find(k => k.includes(key));
                        if (matchedRow) return rowData[matchedRow].map(parseFinNumber).filter(v => v !== null);
                    }
                    return [];
                };

                const salesVals = getAllValues(['매출액']);
                const netVals = getAllValues(['당기순이익']);
                const opVals = getAllValues(['영업이익']);
                const debtVals = getAllValues(['부채비율']);
                const ocfVals = getAllValues(['영업활동으로인한현금흐름', '영업활동']);
                const fcfVals = getAllValues(['FCF']);
                const perVals = getAllValues(['PER(배)', 'PER']);
                const pbrVals = getAllValues(['PBR(배)', 'PBR']);
                const roeVals = getAllValues(['ROE(지배)', 'ROE(%)', 'ROE']);
                const divYieldVals = getAllValues(['현금배당수익률', '배당수익률', '시가배당률']);
                const divPayoutVals = getAllValues(['현금배당성향', '배당성향']);

                const latest = (arr) => arr.length > 0 ? arr[arr.length - 1] : null;
                const prev = (arr) => arr.length > 1 ? arr[arr.length - 2] : null;

                const latestSales = latest(salesVals);
                const prevSales = prev(salesVals);
                const latestNet = latest(netVals);
                const prevNet = prev(netVals);
                const latestOp = latest(opVals);

                const isSalesCont = salesVals.length >= 3 &&
                    salesVals[salesVals.length - 1] > salesVals[salesVals.length - 2] &&
                    salesVals[salesVals.length - 2] > salesVals[salesVals.length - 3];
                const isNetCont = netVals.length >= 3 &&
                    netVals[netVals.length - 1] > netVals[netVals.length - 2] &&
                    netVals[netVals.length - 2] > netVals[netVals.length - 3];

                let opm = (latestOp !== null && latestSales > 0) ? parseFloat(((latestOp / latestSales) * 100).toFixed(2)) : null;
                let salesGrowth = (latestSales !== null && prevSales > 0) ? parseFloat((((latestSales - prevSales) / prevSales) * 100).toFixed(2)) : null;
                let netIncomeGrowth = (latestNet !== null && Math.abs(prevNet) > 0) ? parseFloat((((latestNet - prevNet) / Math.abs(prevNet)) * 100).toFixed(2)) : null;
                let fcfYield = (latest(fcfVals) !== null && stk.marketCap > 0) ? parseFloat(((latest(fcfVals) / stk.marketCap) * 100).toFixed(2)) : null;

                finData = {
                    latestSales,
                    latestNetIncome: latestNet,
                    opm,
                    isContinuousGrowth: isSalesCont && isNetCont,
                    ocfQuality: (latest(ocfVals) !== null && latestNet > 0) ? (latest(ocfVals) >= latestNet) : false,
                    per: latest(perVals),
                    pbr: latest(pbrVals),
                    roe: latest(roeVals),
                    fcf: latest(fcfVals),
                    fcfYield,
                    salesGrowth,
                    netIncomeGrowth,
                    debtRatio: latest(debtVals),
                    ocf: latest(ocfVals),
                    peg: (latest(perVals) > 0 && netIncomeGrowth > 0) ? parseFloat((latest(perVals) / netIncomeGrowth).toFixed(2)) : null,
                    dividendYield: latest(divYieldVals),
                    dividendPayout: latest(divPayoutVals)
                };
            }

            return {
                code: stk.code,
                subSector,
                npsRatio,
                npsChange1W,
                npsChange1M,
                npsChange3M,
                foreignRatio,
                foreignChange,
                ...finData,
                high52,
                low52,
                high52Ratio,
                ma60,
                ma120,
                return3M,
                isUptrend
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

// 3. 단일 종목 심층 리포트
app.get('/api/stock-report', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('종목코드가 필요합니다.');

    try {
        const [naverResp, wiseResp, chartResp, shareResp] = await Promise.all([
            fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, { headers: FETCH_HEADERS }),
            fetch(`https://navercomp.wisereport.co.kr/v2/company/cF1001.aspx?cmp_cd=${code}&fin_typ=0&freq_typ=Y`, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) }),
            fetch(`https://fchart.stock.naver.com/siseJson.naver?symbol=${code}&requestType=0&count=130&timeframe=day`, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) }),
            fetch(`https://navercomp.wisereport.co.kr/v2/company/c1070001.aspx?cmp_cd=${code}`, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) })
        ]);

        const basic = await naverResp.json();
        const wiseHtml = await wiseResp.text();
        const chartRawText = await chartResp.text();
        const shareText = await shareResp.text();
        const { years, rowData } = parseWiseReportHtml(wiseHtml);

        let subSector = '기타';
        const wicsMatch = /WICS\s*:\s*([^<\r\n\t&;,.]+)/i.exec(shareText);
        if (wicsMatch && wicsMatch[1]) {
            subSector = wicsMatch[1].replace(/&nbsp;/g, '').trim();
        }

        const { npsRatio, npsChange1W, npsChange1M, npsChange3M } = parseNpsShareholding(shareText);

        let high52 = '-';
        let low52 = '-';
        let high52Ratio = '-';
        let return3M = '-';
        let foreignRatio = '-';
        let foreignChange = '-';

        try {
            const cleanJsonStr = chartRawText.replace(/\r?\n|\r/g, '').replace(/\s+/g, ' ').replace(/'/g, '"').trim();
            const chartData = JSON.parse(cleanJsonStr);
            const rows = chartData.filter(r => Array.isArray(r) && r.length >= 7 && /^\d{8}$/.test(r[0].toString().trim()));

            if (rows.length > 0) {
                const highs = rows.map(r => parseFloat(r[2])).filter(v => !isNaN(v));
                const lows = rows.map(r => parseFloat(r[3])).filter(v => !isNaN(v));
                const closes = rows.map(r => parseFloat(r[4])).filter(v => !isNaN(v));

                if (highs.length > 0) high52 = Math.max(...highs).toLocaleString() + ' 원';
                if (lows.length > 0) low52 = Math.min(...lows).toLocaleString() + ' 원';

                const cur = parseFinNumber(basic.closePrice) || (closes.length > 0 ? closes[closes.length - 1] : 0);
                const numHigh = Math.max(...highs);
                if (numHigh > 0 && cur > 0) {
                    high52Ratio = ((cur / numHigh) * 100).toFixed(1) + '%';
                }

                if (closes.length >= 60) {
                    const base60 = closes[closes.length - 60];
                    if (base60 > 0) {
                        const r = (((cur - base60) / base60) * 100).toFixed(2);
                        return3M = (r > 0 ? '+' : '') + r + '%';
                    }
                }

                const validFrgnRows = rows.filter(r => !isNaN(parseFloat(r[6])));
                if (validFrgnRows.length >= 2) {
                    const curFrgn = parseFloat(validFrgnRows[validFrgnRows.length - 1][6]);
                    foreignRatio = curFrgn.toFixed(2) + '%';
                    let diff = curFrgn - parseFloat(validFrgnRows[validFrgnRows.length - 2][6]);
                    if (Math.abs(diff) < 0.001) {
                        for (let k = validFrgnRows.length - 3; k >= Math.max(0, validFrgnRows.length - 6); k--) {
                            const pastDiff = curFrgn - parseFloat(validFrgnRows[k][6]);
                            if (Math.abs(pastDiff) >= 0.01) { diff = pastDiff; break; }
                        }
                    }
                    const diffStr = diff.toFixed(2);
                    foreignChange = (diff > 0 ? '+' : '') + diffStr + '%p';
                }
            }
        } catch (e) { }

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

        const fmtNps = (v) => v !== null ? ((v > 0 ? '+' : '') + v + '%p') : '-';

        const html = `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <title>[분석리포트] ${stockName} (${code})</title>
    <style>
        :root { --primary: #2563eb; --bg: #f8fafc; --card: #ffffff; --text: #1e293b; --border: #e2e8f0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 24px; }
        .container { max-width: 1000px; margin: 0 auto; background: var(--card); padding: 32px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); }
        .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid var(--border); padding-bottom: 20px; margin-bottom: 24px; flex-wrap: wrap; gap: 10px; }
        .title h1 { margin: 0; font-size: 26px; color: #0f172a; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .code-badge { font-size: 13px; background: #e0e7ff; color: #3730a3; padding: 4px 10px; border-radius: 6px; }
        .sector-badge { font-size: 13px; background: #fef3c7; color: #92400e; border: 1px solid #fde68a; padding: 4px 10px; border-radius: 6px; }
        .nps-badge { font-size: 13px; background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; padding: 4px 10px; border-radius: 6px; }
        .frgn-badge { font-size: 13px; background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe; padding: 4px 10px; border-radius: 6px; }
        .grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; }
        .card { background: #f8fafc; padding: 14px; border-radius: 10px; border-left: 4px solid var(--primary); }
        .card.purple { border-left-color: #7c3aed; background: #faf5ff; }
        .card.green { border-left-color: #059669; background: #ecfdf5; }
        .card.blue { border-left-color: #2563eb; background: #eff6ff; }
        .label { font-size: 11px; color: #64748b; margin-bottom: 4px; font-weight: 600; }
        .val { font-size: 18px; font-weight: 800; color: #0f172a; }
        .section-title { font-size: 16px; font-weight: 800; margin: 24px 0 10px; color: #334155; }
        table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
        th, td { padding: 9px 12px; text-align: right; border-bottom: 1px solid var(--border); }
        th { background: #f8fafc; font-weight: 700; color: #475569; }
        td.row-title, th:first-child { text-align: left; font-weight: 700; background: #fafafa; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="title">
                <h1>
                    ${stockName} <span class="code-badge">${code}</span>
                    <span class="sector-badge">WICS: ${subSector}</span>
                    <span class="frgn-badge">🌍 외인: ${foreignRatio} (${foreignChange})</span>
                    <span class="nps-badge">🏛️ 국민연금: ${npsRatio !== null ? npsRatio + '%' : '미보유'} (1W: ${fmtNps(npsChange1W)} | 1M: ${fmtNps(npsChange1M)} | 3M: ${fmtNps(npsChange3M)})</span>
                </h1>
            </div>
        </div>
        <div class="grid-4">
            <div class="card"><div class="label">현재가</div><div class="val">${closePrice} 원</div></div>
            <div class="card"><div class="label">시가총액</div><div class="val">${marketCap}</div></div>
            <div class="card"><div class="label">PER</div><div class="val">${per} 배</div></div>
            <div class="card"><div class="label">PBR</div><div class="val">${pbr} 배</div></div>
        </div>
        <div class="grid-4">
            <div class="card blue"><div class="label">🌍 외국인 지분율</div><div class="val">${foreignRatio}</div></div>
            <div class="card blue"><div class="label">🌍 외국인 당일 증감</div><div class="val">${foreignChange}</div></div>
            <div class="card green"><div class="label">🏛️ 국민연금 보유지분</div><div class="val">${npsRatio !== null ? npsRatio + '%' : '-'}</div></div>
            <div class="card purple"><div class="label">52주 최고가 (근접도)</div><div class="val">${high52} <span style="font-size: 13px; color: #7c3aed;">(${high52Ratio})</span></div></div>
        </div>
        <div class="section-title">📊 최근 4개년 연간 재무 요약</div>
        <div style="overflow-x: auto;">
            <table>
                <thead><tr><th style="width: 220px;">주요 계정</th>${yearsHeaderHtml}</tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>
    </div>
</body>
</html>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (e) {
        res.status(500).send(`<h3>리포트 오류: ${e.message}</h3>`);
    }
});

// 4. 캐시 조회
app.get('/api/cached-stocks', (req, res) => {
    if (fs.existsSync(CACHE_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            return res.json({ success: true, count: data.length, data });
        } catch (e) { }
    }
    res.json({ success: true, count: 0, data: [] });
});

// 5. 백그라운드 자동 수집 (NXT 20:00 마감 대응)
async function runBackgroundAutoSync() {
    console.log('[자동스케줄러] NXT 장 마감 후 자동 수집...');
    try {
        const markets = ['KOSPI', 'KOSDAQ'];
        let allStocks = [];

        for (const mkt of markets) {
            let page = 1;
            while (true) {
                const url = `https://m.stock.naver.com/api/stocks/marketValue/${mkt}?page=${page}&pageSize=100`;
                const resp = await fetch(url, { headers: FETCH_HEADERS });
                const data = await resp.json();
                const list = data.stocks || [];
                if (!list || list.length === 0) break;

                for (const s of list) {
                    if (isPureStock(s)) {
                        allStocks.push({
                            code: s.itemCode,
                            name: s.stockName,
                            market: mkt,
                            price: parseFinNumber(s.closePrice),
                            changeRate: parseFinNumber(s.fluctuationsRatio),
                            marketCap: parseFinNumber(s.marketValue)
                        });
                    }
                }
                if (list.length < 100) break;
                page++;
            }
        }

        const chunkSize = 25;
        const total = allStocks.length;
        const enriched = [];

        for (let i = 0; i < total; i += chunkSize) {
            const chunk = allStocks.slice(i, i + chunkSize);
            const chunkResults = await Promise.all(chunk.map(async (stk) => {
                try {
                    const chartJsonUrl = `https://fchart.stock.naver.com/siseJson.naver?symbol=${stk.code}&requestType=0&count=130&timeframe=day`;
                    const chartResp = await fetch(chartJsonUrl, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(6000) });
                    const chartRawText = await chartResp.text();

                    let high52 = null, low52 = null, high52Ratio = null, ma60 = null, ma120 = null, return3M = null, isUptrend = false;
                    let foreignRatio = null, foreignChange = null;

                    try {
                        const cleanJsonStr = chartRawText.replace(/\r?\n|\r/g, '').replace(/\s+/g, ' ').replace(/'/g, '"').trim();
                        const chartData = JSON.parse(cleanJsonStr);
                        const rows = chartData.filter(r => Array.isArray(r) && r.length >= 7 && /^\d{8}$/.test(r[0].toString().trim()));
                        if (rows.length > 0) {
                            const highs = rows.map(r => parseFloat(r[2])).filter(v => !isNaN(v));
                            const lows = rows.map(r => parseFloat(r[3])).filter(v => !isNaN(v));
                            const closes = rows.map(r => parseFloat(r[4])).filter(v => !isNaN(v));
                            if (highs.length > 0) high52 = Math.max(...highs);
                            if (lows.length > 0) low52 = Math.min(...lows);
                            const curPrice = stk.price || (closes.length > 0 ? closes[closes.length - 1] : 0);
                            if (high52 && curPrice > 0) high52Ratio = parseFloat(((curPrice / high52) * 100).toFixed(1));
                            if (closes.length >= 60) {
                                const c60 = Math.round(closes.slice(-60).reduce((a, b) => a + b, 0) / 60);
                                const base60 = closes[closes.length - 60];
                                if (base60 > 0) return3M = parseFloat((((curPrice - base60) / base60) * 100).toFixed(2));
                                isUptrend = curPrice >= c60;
                            }
                            const validFrgnRows = rows.filter(r => !isNaN(parseFloat(r[6])));
                            if (validFrgnRows.length >= 2) {
                                const curFrgn = parseFloat(validFrgnRows[validFrgnRows.length - 1][6]);
                                foreignRatio = parseFloat(curFrgn.toFixed(2));
                                let diff = curFrgn - parseFloat(validFrgnRows[validFrgnRows.length - 2][6]);
                                if (Math.abs(diff) < 0.001) {
                                    for (let k = validFrgnRows.length - 3; k >= Math.max(0, validFrgnRows.length - 6); k--) {
                                        const pastDiff = curFrgn - parseFloat(validFrgnRows[k][6]);
                                        if (Math.abs(pastDiff) >= 0.01) { diff = pastDiff; break; }
                                    }
                                }
                                foreignChange = parseFloat(diff.toFixed(2));
                            }
                        }
                    } catch (e) { }

                    return { ...stk, foreignRatio, foreignChange, high52, low52, high52Ratio, return3M, isUptrend };
                } catch (e) { return stk; }
            }));
            enriched.push(...chunkResults);
        }

        if (fs.existsSync(CACHE_FILE)) {
            try {
                const oldCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
                const eMap = new Map(enriched.map(x => [x.code, x]));
                const merged = oldCache.map(oldItem => {
                    const newItem = eMap.get(oldItem.code);
                    return newItem ? { ...oldItem, ...newItem } : oldItem;
                });
                fs.writeFileSync(CACHE_FILE, JSON.stringify(merged, null, 2), 'utf8');
            } catch (e) { }
        } else {
            fs.writeFileSync(CACHE_FILE, JSON.stringify(enriched, null, 2), 'utf8');
        }
        console.log(`[자동스케줄러] 캐시 갱신 완료 ✅`);
    } catch (e) {
        console.error('[자동스케줄러 오류]', e.message);
    }
}

let lastAutoSyncDate = '';
setInterval(() => {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const kstNow = new Date(utc + (9 * 3600000));
    const day = kstNow.getDay();
    const hour = kstNow.getHours();
    const min = kstNow.getMinutes();
    const dateStr = kstNow.toISOString().slice(0, 10);

    if (day >= 1 && day <= 5 && hour === 20 && min === 5 && lastAutoSyncDate !== dateStr) {
        lastAutoSyncDate = dateStr;
        runBackgroundAutoSync();
    }
}, 30000);

app.listen(PORT, () => {
    console.log(`🚀 퀀트 스크리너 서버 구동 완료: http://localhost:${PORT}`);
});