/**
 * rawmaterial-core.js
 * 태진지엔에스 원료 수불부 - 핵심 로직
 * 설정, Notion API, 계산 함수 분리
 */

// ============================================================
// 설정
// ============================================================
const RAW_CONFIG = {
  PROXY:      'https://notion-proxy.kimtakhyeon.workers.dev',
  NOTION_VER: '2022-06-28',
  MASTER_DB:  'a944bc1c92da461ea25a7cee91b3f54a',
  TX_DB:      'fbd7fbce4ef343d6b6a1a4482febbe4a',
  TOKEN_KEY:  'notion_rawmaterial_token',
};

// ============================================================
// 유틸
// ============================================================
function rawToday() {
  return new Date().toISOString().slice(0, 10);
}

function rawFmt(n) {
  if (n === null || n === undefined || n === '') return '<span class="sb-dash">—</span>';
  if (n === 0) return '<span class="sb-dash">—</span>';
  return parseFloat(n).toLocaleString('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

function rawFmtNZ(n) {
  if (n === null || n === undefined || n === '') return '<span class="sb-dash">—</span>';
  return parseFloat(n).toLocaleString('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

function rawToCsv(rows) {
  return rows.map(r =>
    r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\n');
}

// ============================================================
// Notion API  [버그수정 1] 페이지네이션 - 100건 초과 전체 로드
// ============================================================
async function rawNotionQuery(token, dbId, filter, sorts = []) {
  const url = `${RAW_CONFIG.PROXY}/v1/databases/${dbId.replace(/-/g, '')}/query`;
  let results = [];
  let cursor = undefined;
  let hasMore = true;

  while (hasMore) {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts.length) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Notion-Version': RAW_CONFIG.NOTION_VER,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '노션 오류');

    results = results.concat(data.results || []);
    hasMore = data.has_more;
    cursor  = data.next_cursor;
  }
  return results;
}

async function rawNotionCreate(token, dbId, props) {
  const url = `${RAW_CONFIG.PROXY}/v1/pages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': RAW_CONFIG.NOTION_VER,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: dbId.replace(/-/g, '') },
      properties: props,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '저장 오류');
  return data;
}

// ============================================================
// 노션 속성 파싱
// ============================================================
function rawGetTitle(p, key)  { return p.properties[key]?.title?.[0]?.plain_text  || ''; }
function rawGetRich(p, key)   { return p.properties[key]?.rich_text?.[0]?.plain_text || ''; }
function rawGetSelect(p, key) { return p.properties[key]?.select?.name             || ''; }
function rawGetNum(p, key)    { return p.properties[key]?.number ?? null; }
function rawGetDate(p, key)   { return p.properties[key]?.date?.start              || ''; }

// ============================================================
// 마스터 정규화
// ============================================================
function normalizeRawMaster(rows) {
  return rows.map(p => ({
    id:          p.id,
    원료명:      rawGetTitle(p, '원료명'),
    카테고리:    rawGetSelect(p, '카테고리'),
    품목코드:    rawGetRich(p, '품목코드'),
    단위:        rawGetSelect(p, '단위') || 'kg',
    포대당kg:    rawGetNum(p, '포대당kg'),
    안전재고_kg: rawGetNum(p, '안전재고_kg') || 0,
    원산지:      rawGetSelect(p, '원산지'),
    포대색:      rawGetSelect(p, '포대색'),
  }));
}

// ============================================================
// 트랜잭션 정규화
// ============================================================
function normalizeRawTx(rows) {
  return rows.map(p => ({
    날짜:    rawGetDate(p, '날짜'),
    원료명:  rawGetRich(p, '원료명') || rawGetTitle(p, '항목명'),
    카테고리: rawGetSelect(p, '카테고리'),
    구분:    rawGetSelect(p, '구분'),
    수량_kg: rawGetNum(p, '수량_kg') || 0,
    포대수:  rawGetNum(p, '포대수'),
    담당자:  rawGetRich(p, '담당자'),
    비고:    rawGetRich(p, '비고'),
  }));
}

// ============================================================
// [버그수정 2] 전기이월 계산 - 조회월 1일 이전 누적 재고
// ============================================================
function buildRawCarryover(master, allTxRows, year, month) {
  const cutoff = `${year}-${String(month).padStart(2, '0')}-01`;
  const carryover = {};
  master.forEach(r => { carryover[r.원료명] = 0; });

  for (const tx of allTxRows) {
    if (!tx.날짜 || tx.날짜 >= cutoff) continue;
    const nm  = tx.원료명;
    const qty = tx.수량_kg;
    if (carryover[nm] === undefined) carryover[nm] = 0;

    // [버그수정 3] 폐기도 차감 처리
    if (tx.구분 === '입고') {
      carryover[nm] += qty;
    } else if (['사용(생산투입)', '재고조정', '폐기'].includes(tx.구분)) {
      carryover[nm] -= qty;
    }
  }
  return carryover;
}

// ============================================================
// 현재고 계산 (전체 트랜잭션 기준)
// ============================================================
function buildRawStock(master, allTxRows) {
  const stock = {};
  master.forEach(r => { stock[r.원료명] = 0; });

  for (const tx of allTxRows) {
    const nm  = tx.원료명;
    const qty = tx.수량_kg;
    if (stock[nm] === undefined) stock[nm] = 0;

    if (tx.구분 === '입고') {
      stock[nm] += qty;
    } else if (['사용(생산투입)', '재고조정', '폐기'].includes(tx.구분)) {
      stock[nm] -= qty;
    }
  }
  return stock;
}

// ============================================================
// 수불부 계산 (월별)
// [버그수정 2+3] 전기이월 반영 + 폐기 차감
// ============================================================
function buildRawLedger(master, allTxRows, year, month, cat) {
  const y = parseInt(year), m = parseInt(month);
  const daysInMonth = new Date(y, m, 0).getDate();
  const monthStart  = `${y}-${String(m).padStart(2, '0')}-01`;
  const monthEnd    = new Date(y, m, 0).toISOString().slice(0, 10);

  // 대상 원료
  const rawList = cat ? master.filter(r => r.카테고리 === cat) : master;

  // 전기이월
  const carryover = buildRawCarryover(master, allTxRows, y, m);

  // 당월 트랜잭션만 필터
  const monthTx = allTxRows.filter(tx =>
    tx.날짜 && tx.날짜 >= monthStart && tx.날짜 <= monthEnd
  );

  // 날짜·원료명별 집계  [버그수정 3] 폐기 포함
  const byDayRaw = {};
  for (const tx of monthTx) {
    const day   = parseInt(tx.날짜.slice(8, 10));
    const nm    = tx.원료명;
    const qty   = tx.수량_kg;
    const type  = tx.구분;
    if (!byDayRaw[day]) byDayRaw[day] = {};
    if (!byDayRaw[day][nm]) byDayRaw[day][nm] = { in: 0, used: 0 };

    if (type === '입고') {
      byDayRaw[day][nm].in += qty;
    } else if (['사용(생산투입)', '재고조정', '폐기'].includes(type)) {
      byDayRaw[day][nm].used += qty;
    }
  }

  // 일별 행 생성 (움직임 있는 날만)
  const activeDays = new Set(Object.keys(byDayRaw).map(Number));
  const dailyRows  = [];
  const running    = { ...carryover };

  for (let d = 1; d <= daysInMonth; d++) {
    if (!activeDays.has(d)) continue;
    const row = { day: d, data: {} };
    for (const r of rawList) {
      const nm      = r.원료명;
      const inQty   = byDayRaw[d]?.[nm]?.in   || 0;
      const usedQty = byDayRaw[d]?.[nm]?.used  || 0;
      running[nm]   = (running[nm] || 0) + inQty - usedQty;
      row.data[nm]  = { in: inQty, used: usedQty, stock: running[nm] };
    }
    dailyRows.push(row);
  }

  // 월 합계
  const totals = {};
  rawList.forEach(r => { totals[r.원료명] = { in: 0, used: 0 }; });
  for (const tx of monthTx) {
    const nm   = tx.원료명;
    const qty  = tx.수량_kg;
    const type = tx.구분;
    if (!totals[nm]) continue;
    if (type === '입고') totals[nm].in += qty;
    else if (['사용(생산투입)', '재고조정', '폐기'].includes(type)) totals[nm].used += qty;
  }

  return { rawList, carryover, dailyRows, totals, running };
}
