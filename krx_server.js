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