const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'kospi_cache.json');
const FETCH_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

function parseFinNumber(valStr) {
    if (!valStr) return null;
    let s = valStr.replace(/,/g, '').trim();
    if (s === '' || s === '-' || s === 'N/A') return null;
    if (s.startsWith('(') && s.endsWith(')')) s = '-' + s.slice(1, -1);
    const num = parseFloat(s);
    return isNaN(num) ? null : num;
}

function isPureStock(item) {
    const name = item.stockName || item.name || '';
    const code = item.itemCode || item.code || '';
    if (/[0-9][0-9][0-9][0-9][0-9][1-9A-Z]$/.test(code)) return false;
    const exclude = ['스팩', '우', '우B', '우C', '리츠', 'ETF', 'ETN', '인프라', '펀드', '투융자'];
    for (const kw of exclude) {
        if (name.endsWith(kw) || name.includes(kw + ' ') || name.includes(' ' + kw)) return false;
    }
    return true;
}

function parseWiseReportHtml(html) {
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
        if (title && vals.length > 0) rowData[title] = vals;
    }
    return rowData;
}

async function fetchMarketStocks(marketName) {
    console.log(`🚀 [${marketName}] 전종목 목록 수집 시작...`);
    let page = 1;
    const result = [];
    while (true) {
        const url = `https://m.stock.naver.com/api/stocks/marketValue/${marketName}?page=${page}&pageSize=100`;
        const resp = await fetch(url, { headers: FETCH_HEADERS });
        const data = await resp.json();
        const list = data.stocks || [];
        if (!list || list.length === 0) break;

        for (const s of list) {
            if (isPureStock(s)) {
                result.push({
                    market: marketName,
                    code: s.itemCode,
                    name: s.stockName,
                    price: parseFinNumber(s.closePrice),
                    changeRate: parseFinNumber(s.fluctuationsRatio),
                    marketCap: parseFinNumber(s.marketValue),
                    per: null, pbr: null, roe: null, fcf: null, fcfYield: null,
                    salesGrowth: null, netIncomeGrowth: null, debtRatio: null,
                    ocf: null, peg: null, dividendYield: null, dividendPayout: null
                });
            }
        }
        if (list.length < 100) break;
        page++;
    }
    console.log(`✅ [${marketName}] 보통주 ${result.length}개 확보 완료.`);
    return result;
}

async function run() {
    // 1. 코스피와 코스닥 둘 다 수집!
    const kospiList = await fetchMarketStocks('KOSPI');
    const kosdaqList = await fetchMarketStocks('KOSDAQ');
    const allStocks = [...kospiList, ...kosdaqList];

    console.log(`📊 전시장(KOSPI+KOSDAQ) 총 ${allStocks.length}개 보통주 퀀트 분석 시작...`);

    // 2. 재무 지표 병렬 수집
    const chunkSize = 15;
    for (let i = 0; i < allStocks.length; i += chunkSize) {
        const chunk = allStocks.slice(i, i + chunkSize);
        await Promise.all(chunk.map(async (stk) => {
            try {
                const url = `https://navercomp.wisereport.co.kr/v2/company/cF1001.aspx?cmp_cd=${stk.code}&fin_typ=0&freq_typ=Y`;
                const resp = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(8000) });
                const text = await resp.text();
                const rowData = parseWiseReportHtml(text);

                const getLatestTwo = (key) => {
                    const row = Object.keys(rowData).find(k => k.includes(key));
                    if (!row) return [null, null];
                    const validVals = rowData[row].map(parseFinNumber).filter(v => v !== null);
                    if (validVals.length === 0) return [null, null];
                    return [validVals[validVals.length - 1], validVals.length > 1 ? validVals[validVals.length - 2] : null];
                };

                const [latestSales, prevSales] = getLatestTwo('매출액');
                const [latestNet, prevNet] = getLatestTwo('당기순이익');
                stk.debtRatio = getLatestTwo('부채비율')[0];
                stk.ocf = getLatestTwo('영업활동')[0];
                stk.fcf = getLatestTwo('FCF')[0];
                stk.per = getLatestTwo('PER')[0];
                stk.pbr = getLatestTwo('PBR')[0];
                stk.roe = getLatestTwo('ROE')[0];
                stk.dividendYield = getLatestTwo('시가배당률')[0];
                stk.dividendPayout = getLatestTwo('배당성향')[0];

                if (latestSales !== null && prevSales !== null && prevSales > 0) {
                    stk.salesGrowth = parseFloat((((latestSales - prevSales) / prevSales) * 100).toFixed(2));
                }
                if (latestNet !== null && prevNet !== null && Math.abs(prevNet) > 0) {
                    stk.netIncomeGrowth = parseFloat((((latestNet - prevNet) / Math.abs(prevNet)) * 100).toFixed(2));
                }
                if (stk.fcf !== null && stk.marketCap && stk.marketCap > 0) {
                    stk.fcfYield = parseFloat(((stk.fcf / stk.marketCap) * 100).toFixed(2));
                }
                if (stk.per && stk.per > 0 && stk.netIncomeGrowth && stk.netIncomeGrowth > 0) {
                    stk.peg = parseFloat((stk.per / stk.netIncomeGrowth).toFixed(2));
                }
            } catch (e) { }
        }));

        if ((i + chunkSize) % 150 === 0 || i + chunkSize >= allStocks.length) {
            console.log(`진행률: ${Math.min(i + chunkSize, allStocks.length)} / ${allStocks.length}`);
        }
    }

    fs.writeFileSync(CACHE_FILE, JSON.stringify(allStocks, null, 2), 'utf8');
    console.log(`🎉 kospi_cache.json 저장 완료! 총 ${allStocks.length}개 종목`);
}

run();