/**
 * inventory-core.js
 * 재고 계산 공통 로직 — 재고관리.html / 재고현황_뷰어.html 공유
 *
 * 이 파일만 수정하면 두 앱에 동시 반영됩니다.
 * GitHub: inventory/inventory-core.js
 */

// ── 날짜 ─────────────────────────────────────────
// 한국 시간 기준 오늘 날짜 (자동 새로고침 앱에서는 상수 대신 이 함수 사용)
function localDateStr(d = new Date()){
  const y   = d.getFullYear();
  const m   = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// ── 키 생성 ───────────────────────────────────────
function kk(t){ return t.product+'||'+t.spec+'||'+(t.exp||''); }
function baseObj(t){ return {product:t.product, spec:t.spec, cat:t.cat, exp:t.exp||'', qty:0}; }

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
  if     (t.type==='move-in')  { eF(); fI[k].qty-=t.qty; eS(); sI[k].qty+=t.qty; }
  else if(t.type==='move-out') { eS(); sI[k].qty-=t.qty; eF(); fI[k].qty+=t.qty; }
  else if(t.type==='adjust')   {
    if(t.loc==='천일'){ eF(); fI[k].qty=t.qty; }
    else              { eS(); sI[k].qty=t.qty; }
  }
  else if(t.type==='sample')   {
    // sample: 메모의 [입고]/[출고] 태그로 방향 구분
    const isOut = t.memo && t.memo.startsWith('[출고]');
    if(t.loc==='천일'){
      eF();
      if(isOut) fI[k].qty -= t.qty;
      else      fI[k].qty += t.qty;
    } else {
      eS();
      if(isOut) sI[k].qty -= t.qty;
      else      sI[k].qty += t.qty;
    }
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
    .filter(t => t.date && t.date<=uptoDate)
    .sort((a,b) => a.date.localeCompare(b.date));

  const sI={}, fI={};

  // ── 자사 창고: 최신 스냅샷 기준으로 초기화 ──
  const snaps = sorted.filter(t => t.type==='snapshot');
  if(snaps.length){
    const latD = [...new Set(snaps.map(t=>t.date))].sort().pop();
    // 최신 스냅샷으로 자사 초기화
    snaps.filter(t => t.date===latD)
         .forEach(t => { const k=kk(t); if(!sI[k]) sI[k]=baseObj(t); sI[k].qty+=t.qty; });
    // 스냅샷 이후 이동/조정 반영 (in/out/freeze-set 제외)
    sorted.filter(t => t.date>=latD
                    && t.type!=='snapshot'
                    && t.type!=='freeze-set'
                    && t.type!=='in'
                    && t.type!=='out')
          .forEach(t => applyTx(t, sI, fI)); // sample 포함됨
  } else {
    sorted.filter(t => t.type!=='snapshot'
                    && t.type!=='freeze-set'
                    && t.type!=='in'
                    && t.type!=='out')
          .forEach(t => applyTx(t, sI, fI)); // sample 포함됨
  }

  // ── 천일냉동: freeze-set 또는 adjust(천일) 중 로트별 최신값으로 초기화 ──
  // adjust(천일)도 freeze-set과 동일하게 처리 — freeze-set 없어도 adjust만으로 천일 재고 설정 가능
  const frzSets = sorted.filter(t =>
    t.type==='freeze-set' ||
    (t.type==='adjust' && t.loc==='천일')
  );
  if(frzSets.length){
    // 제품+규격+소비기한(로트) 기준으로 가장 최근 기준값 선택
    const latest = {};
    frzSets.forEach(t => {
      const k = kk(t); // product||spec||exp (로트별 관리)
      if(!latest[k] || t.date>=latest[k].date) latest[k]=t;
    });
    // 최신 기준값으로 fI 초기화
    Object.values(latest).forEach(t => { fI[kk(t)] = {...baseObj(t), qty:t.qty}; });
    // 기준값 날짜 이후 천일 이동만 반영 (out은 이력용이므로 제외)
    const minD = Object.values(latest).map(t=>t.date).sort()[0];
    sorted.filter(t => t.date>minD && (t.type==='move-in' || t.type==='move-out'))
          .forEach(t => applyTx(t, sI, fI));
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
