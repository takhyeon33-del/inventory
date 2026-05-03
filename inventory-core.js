/**
 * inventory-core.js
 * 재고 계산 공통 로직 — 재고관리.html / 재고현황_뷰어.html 공유
 *
 * 수정 핵심
 * 1) 같은 날짜의 snapshot을 단순 합산하지 않고, 제품+규격+소비기한별 최신 snapshot을 기준값으로 사용
 * 2) 날짜만이 아니라 Notion created_time/등록시각까지 반영해 snapshot 이후의 거래만 계산
 * 3) 같은 날 adjust/move/snapshot 순서가 꼬여 새 snapshot이 과거 adjust에 덮이는 문제 방지
 */

// ── 날짜 ─────────────────────────────────────────
// 한국 시간 기준 오늘 날짜 (자동 새로고침 앱에서는 상수 대신 이 함수 사용)
function localDateStr(d = new Date()){
  const y   = d.getFullYear();
  const m   = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// ── 값 정규화 / 키 생성 ───────────────────────────
function norm(v){ return String(v ?? '').trim(); }
function normExp(v){ return norm(v).replace(/\./g,'-').replace(/\//g,'-'); }
function normQty(v){ return Number(v) || 0; }

function kk(t){ return [norm(t.product), norm(t.spec), normExp(t.exp)].join('||'); }
function baseObj(t){ return {product:norm(t.product), spec:norm(t.spec), cat:norm(t.cat)||'기타', exp:normExp(t.exp), qty:0}; }

// ── 거래 순서 ─────────────────────────────────────
// Notion에서 내려오는 created_time / 등록시각 / savedAt 등을 우선 사용한다.
function txTime(t){
  const raw = t.createdTime || t.createdAt || t.created || t.registeredAt || t.savedAt || t['등록시각'] || '';
  const ms = raw ? Date.parse(raw) : NaN;
  if(Number.isFinite(ms)) return ms;
  const d = t.date ? Date.parse(t.date + 'T00:00:00') : 0;
  return Number.isFinite(d) ? d : 0;
}

function txSeq(t){ return txTime(t) + ((Number(t._seq)||0) / 1000000); }
function txCompare(a,b){
  const dc = norm(a.date).localeCompare(norm(b.date));
  if(dc) return dc;
  const tc = txSeq(a) - txSeq(b);
  if(tc) return tc;
  return norm(a.id).localeCompare(norm(b.id));
}
function isAfterTx(t, base){ return !base || txCompare(t, base) > 0; }

// ── kg 계산 ───────────────────────────────────────
function calcKg(spec, qty){
  if(!spec||!qty) return null;
  const kM = spec.match(/([\d.]+)\s*kg/i);
  if(kM) return Math.round(parseFloat(kM[1])*qty*10)/10;
  const gM = spec.match(/([\d.]+)\s*g/i);
  if(gM) return Math.round(parseFloat(gM[1])*qty/100)/10;
  return null;
}

// ── 트랜잭션 적용 ─────────────────────────────────
// 정책: in/out 은 이력 기록용. 재고는 스냅샷 기준이므로 계산 제외
function applyTx(t, sI, fI){
  if(t.type==='in' || t.type==='out') return;
  const k  = kk(t);
  const eS = ()=>{ if(!sI[k]) sI[k]=baseObj(t); };
  const eF = ()=>{ if(!fI[k]) fI[k]=baseObj(t); };
  const q  = normQty(t.qty);
  if     (t.type==='move-in')  { eF(); fI[k].qty-=q; eS(); sI[k].qty+=q; }
  else if(t.type==='move-out') { eS(); sI[k].qty-=q; eF(); fI[k].qty+=q; }
  else if(t.type==='adjust')   {
    if(t.loc==='천일'){ eF(); fI[k].qty=q; }
    else              { eS(); sI[k].qty=q; }
  }
  else if(t.type==='sample')   {
    // sample: 메모의 [입고]/[출고] 태그로 방향 구분
    const isOut = t.memo && t.memo.startsWith('[출고]');
    if(t.loc==='천일'){
      eF();
      if(isOut) fI[k].qty -= q;
      else      fI[k].qty += q;
    } else {
      eS();
      if(isOut) sI[k].qty -= q;
      else      sI[k].qty += q;
    }
  }
}

function applySelfDelta(t, sI){
  if(t.type==='in' || t.type==='out' || t.type==='snapshot' || t.type==='freeze-set') return;
  const k = kk(t);
  const q = normQty(t.qty);
  const eS = ()=>{ if(!sI[k]) sI[k]=baseObj(t); };

  if(t.type==='move-in'){
    eS(); sI[k].qty += q;
  } else if(t.type==='move-out'){
    eS(); sI[k].qty -= q;
  } else if(t.type==='adjust' && t.loc!=='천일'){
    eS(); sI[k].qty = q;
  } else if(t.type==='sample' && t.loc!=='천일'){
    const isOut = t.memo && t.memo.startsWith('[출고]');
    eS();
    if(isOut) sI[k].qty -= q;
    else      sI[k].qty += q;
  }
}

function applyFreezeDelta(t, fI){
  if(!(t.type==='move-in' || t.type==='move-out' || (t.type==='sample' && t.loc==='천일'))) return;
  const k = kk(t);
  const q = normQty(t.qty);
  const eF = ()=>{ if(!fI[k]) fI[k]=baseObj(t); };

  if(t.type==='move-in'){
    eF(); fI[k].qty -= q;
  } else if(t.type==='move-out'){
    eF(); fI[k].qty += q;
  } else if(t.type==='sample'){
    const isOut = t.memo && t.memo.startsWith('[출고]');
    eF();
    if(isOut) fI[k].qty -= q;
    else      fI[k].qty += q;
  }
}

// ── 핵심: 특정 날짜 기준 재고 계산 ──────────────────
/**
 * @param {Array}  transactions  - 전체 트랜잭션 배열
 * @param {Array}  mappings      - 제품 매핑 배열
 * @param {string} uptoDate      - 기준 날짜 (YYYY-MM-DD)
 * @returns {Object} result - { 'product||spec': { product, spec, cat, 자사, 천일, lots[] } }
 */
function buildInventoryAt(transactions, mappings, uptoDate){
  const sorted = [...transactions]
    .map((t,i)=>({...t, _seq: t._seq ?? i, qty:normQty(t.qty), exp:normExp(t.exp)}))
    .filter(t => t.date && t.date<=uptoDate)
    .sort(txCompare);

  const sI={}, fI={};

  // ── 자사 창고: 제품+규격+소비기한별 최신 snapshot으로 초기화 ──
  // 기존 문제: 같은 날짜 snapshot을 모두 더하고, 같은 날짜 adjust를 무조건 마지막에 적용했음.
  // 수정: key별 최신 snapshot 이후의 거래만 시간순으로 반영한다.
  const latestSnap = {};
  sorted.filter(t => t.type==='snapshot').forEach(t => {
    const k = kk(t);
    if(!latestSnap[k] || txCompare(t, latestSnap[k]) >= 0) latestSnap[k] = t;
  });

  Object.values(latestSnap).forEach(t => {
    sI[kk(t)] = {...baseObj(t), qty:normQty(t.qty)};
  });

  sorted.filter(t => !['snapshot','freeze-set','in','out'].includes(t.type))
    .forEach(t => {
      const base = latestSnap[kk(t)];
      if(isAfterTx(t, base)) applySelfDelta(t, sI);
    });

  // snapshot이 하나도 없는 과거/초기 데이터 대응
  if(!Object.keys(latestSnap).length){
    sorted.filter(t => !['snapshot','freeze-set','in','out'].includes(t.type))
      .forEach(t => applySelfDelta(t, sI));
  }

  // ── 천일냉동: freeze-set 또는 adjust(천일) 중 로트별 최신값으로 초기화 ──
  const latestFreeze = {};
  sorted.filter(t => t.type==='freeze-set' || (t.type==='adjust' && t.loc==='천일'))
    .forEach(t => {
      const k = kk(t);
      if(!latestFreeze[k] || txCompare(t, latestFreeze[k]) >= 0) latestFreeze[k] = t;
    });

  Object.values(latestFreeze).forEach(t => {
    fI[kk(t)] = {...baseObj(t), qty:normQty(t.qty)};
  });

  sorted.filter(t => t.type==='move-in' || t.type==='move-out' || (t.type==='sample' && t.loc==='천일'))
    .forEach(t => {
      const base = latestFreeze[kk(t)];
      if(isAfterTx(t, base)) applyFreezeDelta(t, fI);
    });

  // freeze-set이 없는 초기 데이터 대응
  if(!Object.keys(latestFreeze).length){
    sorted.filter(t => t.type==='move-in' || t.type==='move-out' || (t.type==='sample' && t.loc==='천일'))
      .forEach(t => applyFreezeDelta(t, fI));
  }

  // ── 집계: 매핑 DB 기준으로 spec/cat 덮어쓰기 ──
  const result = {};
  const add = (i, loc) => {
    const mi   = mappings.find(m => m.name===i.product);
    const spec = mi ? mi.spec : i.spec;
    const cat  = mi ? mi.cat  : i.cat;
    const rk   = i.product+'||'+spec;
    if(!result[rk]) result[rk] = {product:i.product, spec, cat, 자사:0, 천일:0, lots:[]};
    result[rk][loc] += i.qty;
    // 로트별 소비기한 누적
    if(i.exp){
      const lk = loc+'||'+i.exp;
      const ex = result[rk].lots.find(l => l.key===lk);
      if(ex) ex.qty += i.qty;
      else   result[rk].lots.push({key:lk, loc, exp:i.exp, qty:i.qty});
    }
  };
  Object.values(sI).filter(i => i.qty>0).forEach(i => add(i,'자사'));
  Object.values(fI).filter(i => i.qty>0).forEach(i => add(i,'천일'));
  return result;
}

// ── 소비기한 상태 판단 ────────────────────────────
// localDateStr() 기준으로 비교해서 자정 경계 오차 방지
function expStatus(exp){
  if(!exp) return {cls:'', tag:''};
  const today = new Date(localDateStr()); // 한국 날짜 기준
  const expDate = new Date(exp);
  const d = (expDate - today) / 86400000;
  if(d<0)  return {cls:'row-expired', tag:'<span class="tag tag-danger">만료</span>'};
  if(d<30) return {cls:'row-urgent',  tag:'<span class="tag tag-danger">임박</span>'};
  if(d<90) return {cls:'row-warn-bg', tag:'<span class="tag tag-warn">주의</span>'};
  return {cls:'', tag:''};
}

// ── 카테고리 정렬 순서 ────────────────────────────
const CAT_ORDER = {식당용:0, 통신판매용:1, 기타:2};
