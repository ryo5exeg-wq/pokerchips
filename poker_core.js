"use strict";
/* ============================================================
   ポーカーチップテーブル エンジン（poker_core.js）
   実物のトランプ＋スマホでチップ管理するハイブリッド用。
   カードは現実に配るのでゲーム内に秘匿情報なし。
   - ベッティング進行（ブラインド・チェック/コール/レイズ/フォールド/オールイン）
   - サイドポット計算
   - ショーダウンの手動分配 ＆ カード入力による自動役判定（テキサスホールデム）
   ⚠チップはゲーム内ポイント。現金・物品との交換は賭博になるため禁止。
   ============================================================ */

/* ---------- テーブル ---------- */
function newTable(opts){
  opts=opts||{};
  return {
    sb:+opts.sb||50, bb:+opts.bb||100, initStack:+opts.stack||10000,
    handNo:0, phase:'idle',            /* idle（ハンド間）→ hand → showdown → idle */
    players:[],                        /* {name,stack,bet,cont,folded,allin,acted,inHand,out} */
    dealer:-1, street:0,               /* 0=プリフロップ 1=フロップ 2=ターン 3=リバー */
    turn:-1, currentBet:0, minRaise:0, pot:0,
    showdown:null,                     /* {pots:[{amount,elig:[seat]}], allinRush:bool} */
    lastResult:null,                   /* 直前ハンドの結果表示用 */
    log:[]
  };
}
function log(T,t){ T.log.unshift(t); if(T.log.length>6)T.log.length=6; }

function addPlayer(T,name){
  if(T.phase!=='idle')return {error:'ハンド中は参加できません。次のハンドまでお待ちください'};
  if(T.players.length>=8)return {error:'満席です（最大8人）'};
  T.players.push({name:String(name||'').slice(0,10)||('P'+(T.players.length+1)),
    stack:T.initStack, bet:0, cont:0, folded:false, allin:false, acted:false, inHand:false, out:false});
  log(T,'👋 '+T.players[T.players.length-1].name+' が着席（持ち点'+T.initStack.toLocaleString()+'）');
  return {ok:true, seat:T.players.length-1};
}
function addChips(T,seat,amt){
  const p=T.players[seat]; if(!p)return {error:'no seat'};
  amt=Math.max(0,Math.floor(+amt||0)); if(!amt)return {error:'金額を入れてください'};
  p.stack+=amt; if(p.stack>0)p.out=false;
  log(T,'💰 '+p.name+' にチップ+'+amt.toLocaleString());
  return {ok:true};
}
function removePlayer(T,seat){
  if(T.phase!=='idle')return {error:'ハンド中は退席できません'};
  const p=T.players[seat]; if(!p)return {error:'no seat'};
  p.out=true; p.stack=0; log(T,'🚪 '+p.name+' が退席');
  return {ok:true};
}

/* ---------- ハンド進行 ---------- */
function eligible(T){ return T.players.map((p,i)=>i).filter(i=>!T.players[i].out&&T.players[i].stack>0); }
function nextEligible(T,from){
  const el=eligible(T); if(!el.length)return -1;
  for(let k=1;k<=T.players.length;k++){ const i=(from+k)%T.players.length; if(el.indexOf(i)>=0)return i; }
  return -1;
}
function postBlind(T,seat,amt,label){
  const p=T.players[seat];
  const pay=Math.min(p.stack,amt);
  p.stack-=pay; p.bet=pay;
  if(p.stack===0){p.allin=true; log(T,'🔥 '+p.name+' '+label+'でオールイン');}
}
function startHand(T){
  if(T.phase!=='idle')return {error:'進行中のハンドがあります'};
  const el=eligible(T);
  if(el.length<2)return {error:'チップを持つプレイヤーが2人以上必要です'};
  T.handNo++; T.phase='hand'; T.street=0; T.pot=0; T.currentBet=0; T.showdown=null; T.lastResult=null;
  T.players.forEach(p=>{p.bet=0;p.cont=0;p.folded=false;p.allin=false;p.acted=false;p.inHand=false;});
  el.forEach(i=>{T.players[i].inHand=true;});
  T.dealer=nextEligible(T,(T.dealer<0? T.players.length-1 : T.dealer));
  let sbSeat, bbSeat;
  if(el.length===2){ sbSeat=T.dealer; bbSeat=nextEligible(T,T.dealer); }        /* ヘッズアップはD=SB */
  else{ sbSeat=nextEligible(T,T.dealer); bbSeat=nextEligible(T,sbSeat); }
  postBlind(T,sbSeat,T.sb,'SB'); postBlind(T,bbSeat,T.bb,'BB');
  T.currentBet=T.bb; T.minRaise=T.bb;
  T.turn=nextActor(T,bbSeat);
  T.sbSeat=sbSeat; T.bbSeat=bbSeat;
  log(T,'🃏 ハンド#'+T.handNo+' 開始（D:'+T.players[T.dealer].name+'）カードを配ってください');
  if(T.turn<0)endStreet(T); /* 全員ブラインドオールイン等の超レアケース */
  return {ok:true};
}
function needsAction(T,i){
  const p=T.players[i];
  return p.inHand&&!p.folded&&!p.allin&&(p.bet<T.currentBet||!p.acted);
}
function nextActor(T,from){
  for(let k=1;k<=T.players.length;k++){
    const i=(from+k)%T.players.length;
    if(needsAction(T,i))return i;
  }
  return -1;
}
function livePlayers(T){ return T.players.map((p,i)=>i).filter(i=>T.players[i].inHand&&!T.players[i].folded); }
function toCall(T,seat){ const p=T.players[seat]; return Math.max(0,Math.min(T.currentBet-p.bet,p.stack)); }

function act(T,seat,move){
  if(T.phase!=='hand')return {error:'いまはベットできません'};
  if(T.turn!==seat)return {error:'あなたの番ではありません'};
  const p=T.players[seat];
  const type=move.type;
  if(type==='fold'){ p.folded=true; p.acted=true; log(T,'🙅 '+p.name+' フォールド'); }
  else if(type==='check'){
    if(p.bet!==T.currentBet)return {error:'チェックできません（コールが必要です）'};
    p.acted=true; log(T,'✋ '+p.name+' チェック');
  }
  else if(type==='call'){
    const pay=toCall(T,seat);
    if(pay<=0)return {error:'コールする額がありません（チェックしてください）'};
    p.stack-=pay; p.bet+=pay; p.acted=true;
    if(p.stack===0){p.allin=true; log(T,'🔥 '+p.name+' コールでオールイン（'+p.bet.toLocaleString()+'）');}
    else log(T,'📞 '+p.name+' コール（'+p.bet.toLocaleString()+'）');
  }
  else if(type==='raise'||type==='allin'){
    let X=(type==='allin')?(p.bet+p.stack):Math.floor(+move.to||0);
    if(X>p.bet+p.stack)return {error:'チップが足りません'};
    if(X<=T.currentBet){
      if(type!=='allin')return {error:'現在のベット（'+T.currentBet.toLocaleString()+'）より大きい額にしてください'};
      /* 足りないオールイン＝コール扱い */
      const pay2=p.stack; p.bet+=pay2; p.stack=0; p.allin=true; p.acted=true;
      log(T,'🔥 '+p.name+' オールイン（'+p.bet.toLocaleString()+'）');
    }else{
      const full=(X>=T.currentBet+T.minRaise);
      if(!full&&X!==p.bet+p.stack)return {error:'最低レイズは '+(T.currentBet+T.minRaise).toLocaleString()+' です'};
      const pay3=X-p.bet;
      p.stack-=pay3; p.bet=X; p.acted=true;
      if(full)T.minRaise=X-T.currentBet;
      T.currentBet=X;
      T.players.forEach((q,qi)=>{ if(qi!==seat&&q.inHand&&!q.folded&&!q.allin)q.acted=false; });
      if(p.stack===0){p.allin=true; log(T,'🔥 '+p.name+' レイズオールイン（'+X.toLocaleString()+'）');}
      else log(T,'📢 '+p.name+' レイズ → '+X.toLocaleString());
    }
  }
  else return {error:'不明な操作です'};

  /* 残り1人 → 即勝ち */
  if(livePlayers(T).length===1){
    collectBets(T);
    const w=livePlayers(T)[0], q=T.players[w];
    q.stack+=T.pot;
    T.lastResult={type:'fold',text:'🏆 '+q.name+' の勝ち（全員フォールド）+'+T.pot.toLocaleString()};
    log(T,T.lastResult.text);
    T.pot=0; finishHand(T);
    return {ok:true};
  }
  const nx=nextActor(T,seat);
  if(nx<0)endStreet(T); else T.turn=nx;
  return {ok:true};
}
function collectBets(T){
  T.players.forEach(p=>{ p.cont+=p.bet; T.pot+=p.bet; p.bet=0; p.acted=false; });
}
function endStreet(T){
  collectBets(T);
  const actable=T.players.filter(p=>p.inHand&&!p.folded&&!p.allin).length;
  if(T.street===3||actable<=1){
    T.phase='showdown';
    T.showdown={pots:buildPots(T), allinRush:(T.street<3)};
    T.turn=-1;
    log(T,(T.street<3?'🔥 ベット終了（オールイン）。残りのカードをめくって':'')+'🃏 ショーダウン！勝者を選ぶかカードで判定');
    return;
  }
  T.street++; T.currentBet=0; T.minRaise=T.bb;
  T.turn=nextActor(T,T.dealer);
  const SN=['プリフロップ','フロップ','ターン','リバー'];
  log(T,'▶ '+SN[T.street]+'：'+(T.street===1?'場に3枚':'場に1枚')+'めくってください');
  if(T.turn<0)endStreet(T);
}
function finishHand(T){
  T.phase='idle'; T.turn=-1; T.showdown=null;
  T.players.forEach(p=>{ if(p.inHand&&p.stack===0&&!p.out)log(T,'💀 '+p.name+' が飛びました（チップ追加で復帰できます）'); });
}

/* ---------- ポット（サイドポット対応） ---------- */
function buildPots(T){
  const levels=[...new Set(T.players.filter(p=>p.cont>0).map(p=>p.cont))].sort((a,b)=>a-b);
  const pots=[]; let prev=0;
  levels.forEach(L=>{
    let amt=0;
    T.players.forEach(p=>{ amt+=Math.max(0,Math.min(p.cont,L)-prev); });
    const elig=T.players.map((p,i)=>i).filter(i=>{
      const p=T.players[i]; return p.inHand&&!p.folded&&p.cont>=L;
    });
    if(amt>0){
      const last=pots[pots.length-1];
      if(last&&last.elig.join()===elig.join())last.amount+=amt;
      else pots.push({amount:amt,elig:elig});
    }
    prev=L;
  });
  return pots;
}
/* 手動分配。winnersPerPot=[[seat,...], ...]（ポットごとの勝者。チョップは複数） */
function awardPots(T,winnersPerPot,detail){
  if(T.phase!=='showdown')return {error:'いまは分配できません'};
  const pots=T.showdown.pots;
  if(!Array.isArray(winnersPerPot)||winnersPerPot.length!==pots.length)return {error:'ポットの数と勝者の数が合いません'};
  for(let i=0;i<pots.length;i++){
    const ws=winnersPerPot[i];
    if(!Array.isArray(ws)||!ws.length)return {error:'ポット'+(i+1)+'の勝者を選んでください'};
    for(const w of ws)if(pots[i].elig.indexOf(w)<0)return {error:T.players[w].name+' はポット'+(i+1)+'の対象ではありません'};
  }
  const gains={};
  pots.forEach((pot,i)=>{
    const ws=winnersPerPot[i];
    const share=Math.floor(pot.amount/ws.length);
    let rem=pot.amount-share*ws.length;
    ws.forEach(w=>{ let g=share; if(rem>0){g++;rem--;} T.players[w].stack+=g; gains[w]=(gains[w]||0)+g; });
  });
  const parts=Object.keys(gains).map(w=>T.players[w].name+' +'+gains[w].toLocaleString());
  T.lastResult={type:detail?'judge':'manual',text:'🏆 '+parts.join('　'),detail:detail||null};
  log(T,T.lastResult.text);
  T.pot=0; finishHand(T);
  return {ok:true};
}

/* ---------- 役判定（テキサスホールデム・7枚から最強5枚） ---------- */
/* カードは {r:2..14, s:0..3}。r14=A */
function score5(cs){
  const rs=cs.map(c=>c.r).sort((a,b)=>b-a);
  const flush=cs.every(c=>c.s===cs[0].s);
  const uniq=[...new Set(rs)];
  let straight=0;
  if(uniq.length===5){
    if(uniq[0]-uniq[4]===4)straight=uniq[0];
    else if(uniq[0]===14&&uniq[1]===5)straight=5;   /* A-5のホイール */
  }
  const cnt={}; rs.forEach(r=>cnt[r]=(cnt[r]||0)+1);
  const groups=Object.keys(cnt).map(Number).sort((a,b)=>(cnt[b]-cnt[a])||(b-a));
  const shape=groups.map(g=>cnt[g]).join('');
  if(flush&&straight)return [8,straight];
  if(shape[0]==='4')return [7,groups[0],groups[1]];
  if(shape==='32')return [6,groups[0],groups[1]];
  if(flush)return [5].concat(rs);
  if(straight)return [4,straight];
  if(shape[0]==='3')return [3,groups[0],groups[1],groups[2]];
  if(shape==='221')return [2,groups[0],groups[1],groups[2]];
  if(shape[0]==='2')return [1,groups[0],groups[1],groups[2],groups[3]];
  return [0].concat(rs);
}
function cmpScore(a,b){
  for(let i=0;i<Math.max(a.length,b.length);i++){
    const x=a[i]||0,y=b[i]||0;
    if(x!==y)return x-y;
  }
  return 0;
}
function best7(cards7){
  let best=null;
  for(let a=0;a<3;a++)for(let b=a+1;b<4;b++)for(let c=b+1;c<5;c++)for(let d=c+1;d<6;d++)for(let e=d+1;e<7;e++){
    const s=score5([cards7[a],cards7[b],cards7[c],cards7[d],cards7[e]]);
    if(!best||cmpScore(s,best)>0)best=s;
  }
  return best;
}
const RANK_JP={14:'A',13:'K',12:'Q',11:'J',10:'10',9:'9',8:'8',7:'7',6:'6',5:'5',4:'4',3:'3',2:'2'};
function handName(sc){
  const c=sc[0];
  if(c===8)return sc[1]===14?'ロイヤルフラッシュ':'ストレートフラッシュ（'+RANK_JP[sc[1]]+'ハイ）';
  if(c===7)return 'フォーカード（'+RANK_JP[sc[1]]+'）';
  if(c===6)return 'フルハウス（'+RANK_JP[sc[1]]+' over '+RANK_JP[sc[2]]+'）';
  if(c===5)return 'フラッシュ（'+RANK_JP[sc[1]]+'ハイ）';
  if(c===4)return 'ストレート（'+RANK_JP[sc[1]]+'ハイ）';
  if(c===3)return 'スリーカード（'+RANK_JP[sc[1]]+'）';
  if(c===2)return 'ツーペア（'+RANK_JP[sc[1]]+'＆'+RANK_JP[sc[2]]+'）';
  if(c===1)return 'ワンペア（'+RANK_JP[sc[1]]+'）';
  return 'ハイカード（'+RANK_JP[sc[1]]+'）';
}
/* judge: board=[5枚], holes={seat:[2枚]}（残っている全員分）→ 自動で全ポット分配 */
function judgeShowdown(T,board,holes){
  if(T.phase!=='showdown')return {error:'いまは判定できません'};
  if(!Array.isArray(board)||board.length!==5)return {error:'ボードの5枚を入力してください'};
  const live=livePlayers(T);
  for(const s of live){
    if(!holes||!Array.isArray(holes[s])||holes[s].length!==2)
      return {error:T.players[s].name+' の手札2枚を入力してください'};
  }
  /* 重複カードチェック */
  const all=board.slice(); live.forEach(s=>{all.push(holes[s][0],holes[s][1]);});
  const seen={};
  for(const c of all){
    const k=c.r+'-'+c.s;
    if(seen[k])return {error:'同じカードが2回入力されています（'+RANK_JP[c.r]+'）'};
    seen[k]=1;
  }
  const scores={}, names={};
  live.forEach(s=>{
    scores[s]=best7(board.concat(holes[s]));
    names[s]=handName(scores[s]);
  });
  const winnersPerPot=T.showdown.pots.map(pot=>{
    let best=null,ws=[];
    pot.elig.forEach(s=>{
      if(!best||cmpScore(scores[s],best)>0){best=scores[s];ws=[s];}
      else if(cmpScore(scores[s],best)===0)ws.push(s);
    });
    return ws;
  });
  const detail=live.map(s=>({seat:s,name:T.players[s].name,hand:names[s]}));
  const r=awardPots(T,winnersPerPot,detail);
  if(r.error)return r;
  return {ok:true,detail:detail};
}

/* ============================================================
   サーバー側API（Cloudflare Worker用。他ゲームと同じ形）
   秘匿情報なし＝viewForは全公開＋自席情報のみ付与。AIなし。
   ============================================================ */
let ST=null;
function getState(){return ST;}
function setState(s){ST=s;}
function createTable(opts){ ST=newTable(opts); return ST; }
function serverStep(){ return 0; } /* AIなし・自動進行なし */
function viewFor(seat){
  if(!ST)return null;
  const v=JSON.parse(JSON.stringify(ST));
  v.you=seat;
  if(seat>=0&&ST.players[seat])v.toCall=toCall(ST,seat);
  return v;
}
/* isHost=true はテーブル画面（進行役）。着席者の操作は自席のみ */
function applyAction(seat,a,isHost){
  if(!ST)return {error:'no table'};
  a=a||{};
  try{
    switch(a.type){
      case 'check': case 'call': case 'fold': case 'raise': case 'allin':
        return act(ST,seat,a);
      case 'start':    if(!isHost)return {error:'テーブル画面から操作してください'}; return startHand(ST);
      case 'award':    if(!isHost)return {error:'テーブル画面から操作してください'}; return awardPots(ST,a.winners);
      case 'judge':    if(!isHost)return {error:'テーブル画面から操作してください'}; return judgeShowdown(ST,a.board,a.holes);
      case 'addChips': if(!isHost)return {error:'テーブル画面から操作してください'}; return addChips(ST,a.seat,a.amt);
      case 'kick':     if(!isHost)return {error:'テーブル画面から操作してください'}; return removePlayer(ST,a.seat);
      case 'foldFor':  if(!isHost)return {error:'テーブル画面から操作してください'};
        if(ST.phase!=='hand'||ST.turn!==a.seat)return {error:'その人の番ではありません'};
        return act(ST,a.seat,{type:'fold'});
    }
    return {error:'不明な操作です'};
  }catch(e){ return {error:'その操作はできません'}; }
}
function joinTable(name){
  if(!ST)return {error:'no table'};
  return addPlayer(ST,name);
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={
    newTable,addPlayer,addChips,removePlayer,startHand,act,toCall,buildPots,awardPots,
    score5,cmpScore,best7,handName,judgeShowdown,livePlayers,
    getState,setState,createTable,serverStep,viewFor,applyAction,joinTable,RANK_JP
  };
}
