function obNumberFromUrl(u = '') {
    const m = normUrl(u).match(/\/ob(\d+)[-/]?/i);
    return m ? Number(m[1]) : 0;
}

export function sortOldToNew(items) {
    return items.slice().sort((a, b) => {
        const ta = Date.parse(a.timeISO || '') || obNumberFromUrl(a.url) || 0;
        const tb = Date.parse(b.timeISO || '') || obNumberFromUrl(b.url) || 0;
        return ta - tb;
    });
}
