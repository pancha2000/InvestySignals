/**
 * InvestySignals — Analysis Indicators v2
 * public/analysis/indicator.js
 *
 * Indicators: EMA, RSI, MACD, Bollinger Bands, Stochastic RSI, ATR, ADX, OBV, Volume
 * Entry Decision: 8-factor confluence scoring system
 *
 * Load order in analysis.html:
 *   1. Firebase module
 *   2. <script src="analysis/indicator.js">  <- this file
 *   3. Main inline script
 */

const BINANCE_FAPI = 'https://fapi.binance.com';
const SCAN_LIMIT   = 50;
const RSI_PERIOD   = 14;
const KLINE_LIMIT  = 150;
const KLINE_TF     = '1h';

function fmtPrice(p){
  const n=parseFloat(p);
  if(n>=1000)return'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  if(n>=1)return'$'+n.toFixed(4);
  if(n>=0.01)return'$'+n.toFixed(5);
  return'$'+n.toFixed(6);
}
function fmtVol(v){
  const n=parseFloat(v);
  if(n>=1e9)return'$'+(n/1e9).toFixed(2)+'B';
  if(n>=1e6)return'$'+(n/1e6).toFixed(1)+'M';
  return'$'+(n/1e3).toFixed(0)+'K';
}

function calcEMA(closes,period){
  if(!closes||closes.length<period)return null;
  const k=2/(period+1);
  let ema=closes.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<closes.length;i++)ema=closes[i]*k+ema*(1-k);
  return ema;
}
function calcEMAArray(closes,period){
  if(!closes||closes.length<period)return[];
  const k=2/(period+1);
  const result=[];
  let ema=closes.slice(0,period).reduce((a,b)=>a+b,0)/period;
  result.push(ema);
  for(let i=period;i<closes.length;i++){ema=closes[i]*k+ema*(1-k);result.push(ema);}
  return result;
}

function calcRSI(closes,period){
  if(!closes||closes.length<period+1)return null;
  let gains=0,losses=0;
  for(let i=1;i<=period;i++){const d=closes[i]-closes[i-1];if(d>0)gains+=d;else losses-=d;}
  let ag=gains/period,al=losses/period;
  for(let i=period+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    ag=(ag*(period-1)+(d>0?d:0))/period;
    al=(al*(period-1)+(d<0?-d:0))/period;
  }
  if(al===0)return 100;
  return 100-(100/(1+ag/al));
}

function calcMACD(closes,fast=12,slow=26,signal=9){
  if(!closes||closes.length<slow+signal)return null;
  const ef=calcEMAArray(closes,fast);
  const es=calcEMAArray(closes,slow);
  const offset=slow-fast;
  const macdLine=ef.slice(offset).map((v,i)=>v-es[i]);
  const sigArr=calcEMAArray(macdLine,signal);
  const lastM=macdLine[macdLine.length-1];
  const lastS=sigArr[sigArr.length-1];
  const hist=lastM-lastS;
  const prevH=macdLine[macdLine.length-2]-sigArr[sigArr.length-2];
  return{macd:lastM,signal:lastS,histogram:hist,prevHistogram:prevH,trend:lastM>lastS?'bullish':'bearish',strengthening:Math.abs(hist)>Math.abs(prevH)};
}

function calcBollingerBands(closes,period=20,mult=2){
  if(!closes||closes.length<period)return null;
  const sl=closes.slice(-period);
  const mean=sl.reduce((a,b)=>a+b,0)/period;
  const std=Math.sqrt(sl.reduce((s,v)=>s+(v-mean)**2,0)/period);
  const upper=mean+mult*std,lower=mean-mult*std;
  const width=(upper-lower)/mean;
  const last=closes[closes.length-1];
  const pos=(last-lower)/(upper-lower);
  return{upper,middle:mean,lower,width,position:Math.max(0,Math.min(1,pos)),squeeze:width<0.04};
}

function calcStochasticRSI(closes,rsiP=14,stochP=14,kS=3,dS=3){
  if(!closes||closes.length<rsiP+stochP+kS+dS)return null;
  const rsiArr=[];
  for(let i=rsiP;i<closes.length;i++)rsiArr.push(calcRSI(closes.slice(0,i+1),rsiP));
  if(rsiArr.length<stochP)return null;
  const stochArr=[];
  for(let i=stochP-1;i<rsiArr.length;i++){
    const w=rsiArr.slice(i-stochP+1,i+1);
    const lo=Math.min(...w),hi=Math.max(...w);
    stochArr.push(hi===lo?50:((rsiArr[i]-lo)/(hi-lo))*100);
  }
  const kArr=calcEMAArray(stochArr,kS);
  const dArr=calcEMAArray(kArr,dS);
  const k=kArr[kArr.length-1],d=dArr[dArr.length-1];
  const pk=kArr[kArr.length-2],pd=dArr[dArr.length-2];
  return{k,d,signal:k<20?'oversold':k>80?'overbought':'neutral',crossover:k>d&&pk<=pd?'bullish_cross':k<d&&pk>=pd?'bearish_cross':null};
}

function calcATR(highs,lows,closes,period=14){
  if(!highs||highs.length<period+1)return null;
  const tr=[];
  for(let i=1;i<highs.length;i++)tr.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));
  let atr=tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<tr.length;i++)atr=(atr*(period-1)+tr[i])/period;
  return{atr,pct:(atr/closes[closes.length-1])*100};
}

function calcADX(highs,lows,closes,period=14){
  if(!highs||highs.length<period*2)return null;
  const pdm=[],mdm=[],tr=[];
  for(let i=1;i<highs.length;i++){
    const up=highs[i]-highs[i-1],dn=lows[i-1]-lows[i];
    pdm.push(up>dn&&up>0?up:0);
    mdm.push(dn>up&&dn>0?dn:0);
    tr.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));
  }
  function ws(arr,p){let s=arr.slice(0,p).reduce((a,b)=>a+b,0);const r=[s];for(let i=p;i<arr.length;i++){s=s-s/p+arr[i];r.push(s);}return r;}
  const sTR=ws(tr,period),sPDM=ws(pdm,period),sMDM=ws(mdm,period);
  const di=sTR.map((t,i)=>({plus:t>0?(sPDM[i]/t)*100:0,minus:t>0?(sMDM[i]/t)*100:0}));
  const dx=di.map(d=>{const s=d.plus+d.minus;return s>0?(Math.abs(d.plus-d.minus)/s)*100:0;});
  let adx=dx.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<dx.length;i++)adx=(adx*(period-1)+dx[i])/period;
  const last=di[di.length-1];
  return{adx,plusDI:last.plus,minusDI:last.minus,trend:adx>25?(last.plus>last.minus?'bullish':'bearish'):'ranging',strength:adx>50?'strong':adx>25?'moderate':'weak'};
}

function calcOBV(closes,volumes){
  if(!closes||closes.length<10)return null;
  let obv=0;const arr=[0];
  for(let i=1;i<closes.length;i++){if(closes[i]>closes[i-1])obv+=volumes[i];else if(closes[i]<closes[i-1])obv-=volumes[i];arr.push(obv);}
  const l5=arr.slice(-5).reduce((a,b)=>a+b,0)/5;
  const p5=arr.slice(-10,-5).reduce((a,b)=>a+b,0)/5;
  return{obv,trend:l5>p5?'accumulation':'distribution',rising:l5>p5};
}

function analyzeVolume(klines){
  const vols=klines.map(k=>parseFloat(k[5]));
  const avg20=vols.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
  const last3=vols.slice(-4,-1).reduce((a,b)=>a+b,0)/3;
  const ratio=avg20>0?last3/avg20:1;
  return{avg20,last3,ratio,surge:ratio>=1.5,label:ratio>=2?'Very High':ratio>=1.5?'High':ratio>=1?'Normal':'Low'};
}

function decideEntry(rsi,volInfo,closes,highs,lows,currentPrice,macd,bb,stochRsi,adx,obv,atr){
  let ls=0,ss=0;
  // RSI scoring
  if(rsi<=25){ls+=25;}else if(rsi<=35){ls+=20;}else if(rsi<=42){ls+=12;}else if(rsi<=48){ls+=4;ss+=4;}
  else if(rsi>=75){ss+=25;}else if(rsi>=65){ss+=20;}else if(rsi>=58){ss+=12;}
  // EMA
  const ema20=calcEMA(closes,20),ema50=calcEMA(closes,50);
  if(ema20&&ema50){
    if(ema20>ema50&&currentPrice>ema20)ls+=15;else if(ema20>ema50)ls+=8;
    if(ema20<ema50&&currentPrice<ema20)ss+=15;else if(ema20<ema50)ss+=8;
  }
  // MACD
  if(macd){
    if(macd.trend==='bullish'&&macd.strengthening)ls+=15;else if(macd.trend==='bullish')ls+=8;
    if(macd.trend==='bearish'&&macd.strengthening)ss+=15;else if(macd.trend==='bearish')ss+=8;
  }
  // Bollinger
  if(bb){
    if(bb.position<=0.1)ls+=10;else if(bb.position<=0.25)ls+=6;
    if(bb.position>=0.9)ss+=10;else if(bb.position>=0.75)ss+=6;
    if(bb.squeeze){ls+=3;ss+=3;}
  }
  // Stochastic RSI
  if(stochRsi){
    if(stochRsi.signal==='oversold')ls+=10;else if(stochRsi.crossover==='bullish_cross')ls+=6;
    if(stochRsi.signal==='overbought')ss+=10;else if(stochRsi.crossover==='bearish_cross')ss+=6;
  }
  // ADX
  if(adx){
    if(adx.strength==='strong'){if(adx.trend==='bullish')ls+=10;else if(adx.trend==='bearish')ss+=10;}
    else if(adx.strength==='moderate'){if(adx.trend==='bullish')ls+=6;else if(adx.trend==='bearish')ss+=6;else{ls+=3;ss+=3;}}
    else{ls+=2;ss+=2;}
  }
  // OBV
  if(obv){if(obv.trend==='accumulation')ls+=10;else ss+=10;}
  // Volume
  if(volInfo.surge){ls+=10;ss+=10;}else if(volInfo.ratio>=1){ls+=5;ss+=5;}

  const MAX=105;
  const lc=Math.min(100,Math.round((ls/MAX)*100));
  const sc=Math.min(100,Math.round((ss/MAX)*100));
  let direction='NEUTRAL',confidence=0;
  if(lc>=45||sc>=45){direction=lc>=sc?'LONG':'SHORT';confidence=direction==='LONG'?lc:sc;}

  let entryType='LIMIT';
  if(confidence>=70&&volInfo.surge){
    if((direction==='LONG'&&rsi<=35)||(direction==='SHORT'&&rsi>=65))entryType='MARKET';
  }

  const atrVal=atr?atr.atr:currentPrice*0.015;
  const r10H=Math.max(...highs.slice(-10)),r10L=Math.min(...lows.slice(-10));
  const r5H=Math.max(...highs.slice(-5)),r5L=Math.min(...lows.slice(-5));

  let ep,sl,tp1,tp2;
  if(direction==='LONG'){
    ep=entryType==='MARKET'?currentPrice:r5L;
    sl=Math.min(r10L,ep-atrVal*1.5);
    const rk=ep-sl;tp1=ep+rk*1.5;tp2=ep+rk*2.8;
  }else if(direction==='SHORT'){
    ep=entryType==='MARKET'?currentPrice:r5H;
    sl=Math.max(r10H,ep+atrVal*1.5);
    const rk=sl-ep;tp1=ep-rk*1.5;tp2=ep-rk*2.8;
  }else{ep=sl=tp1=tp2=currentPrice;}

  const rk=direction==='LONG'?ep-sl:sl-ep;
  const rrr1=rk>0?(Math.abs(tp1-ep)/rk).toFixed(1):'—';
  const rrr2=rk>0?(Math.abs(tp2-ep)/rk).toFixed(1):'—';
  return{direction,entryType,confidence,entryPrice:ep,slPrice:sl,tp1Price:tp1,tp2Price:tp2,rrr1,rrr2,longScore:ls,shortScore:ss,indicators:{ema20,ema50,macd,bb,stochRsi,adx,obv,atr}};
}

function buildReasons(rsi,volInfo,result){
  const reasons=[];
  const{direction,entryType,confidence,indicators,rrr1,rrr2}=result;
  const{ema20,ema50,macd,bb,stochRsi,adx,obv,atr}=indicators;
  const r=rsi.toFixed(1);
  if(direction==='NEUTRAL'){reasons.push({icon:'⏸️',text:`RSI <strong>${r}</strong> — no strong directional bias. Wait for a clearer setup.`});return reasons;}
  if(direction==='LONG'){
    if(rsi<=25)reasons.push({icon:'🟢',text:`RSI <strong>${r}</strong> — extreme oversold. High-probability mean-reversion long.`});
    else if(rsi<=35)reasons.push({icon:'🟢',text:`RSI <strong>${r}</strong> — oversold. Strong long setup.`});
    else reasons.push({icon:'🟡',text:`RSI <strong>${r}</strong> — mild bearish. Long bias supported by confluence.`});
  }else{
    if(rsi>=75)reasons.push({icon:'🔴',text:`RSI <strong>${r}</strong> — extreme overbought. High-probability short reversal.`});
    else if(rsi>=65)reasons.push({icon:'🔴',text:`RSI <strong>${r}</strong> — overbought. Strong short setup.`});
    else reasons.push({icon:'🟠',text:`RSI <strong>${r}</strong> — mild bullish. Short bias supported by confluence.`});
  }
  if(ema20&&ema50){
    const et=ema20>ema50?'bullish':'bearish';
    if(direction==='LONG'&&et==='bullish')reasons.push({icon:'📈',text:`EMA20 ${fmtPrice(ema20)} <strong>above EMA50</strong> ${fmtPrice(ema50)} — uptrend confirmed, trade aligned.`});
    else if(direction==='LONG')reasons.push({icon:'⚠️',text:`EMA20 below EMA50 — counter-trend long. Use smaller size.`});
    else if(direction==='SHORT'&&et==='bearish')reasons.push({icon:'📉',text:`EMA20 ${fmtPrice(ema20)} <strong>below EMA50</strong> ${fmtPrice(ema50)} — downtrend confirmed, trade aligned.`});
    else reasons.push({icon:'⚠️',text:`EMA20 above EMA50 — counter-trend short. Tighter SL recommended.`});
  }
  if(macd){
    const hd=macd.histogram>0?'positive':'negative',gr=macd.strengthening?'& growing':'';
    reasons.push({icon:'📊',text:`MACD histogram <strong>${hd}</strong> ${gr} — momentum ${direction==='LONG'?'building':'fading'}.`});
  }
  if(bb){
    if(direction==='LONG'&&bb.position<=0.2)reasons.push({icon:'🎯',text:`Price near <strong>lower Bollinger Band</strong> — mean-reversion long zone.`});
    else if(direction==='SHORT'&&bb.position>=0.8)reasons.push({icon:'🎯',text:`Price near <strong>upper Bollinger Band</strong> — mean-reversion short zone.`});
    if(bb.squeeze)reasons.push({icon:'💥',text:`<strong>Bollinger Squeeze</strong> detected — breakout imminent.`});
  }
  if(stochRsi){
    if(stochRsi.signal==='oversold'&&direction==='LONG')reasons.push({icon:'⚡',text:`Stoch RSI <strong>oversold</strong> (K: ${stochRsi.k.toFixed(1)}) — confirms long momentum exhaustion.`});
    else if(stochRsi.signal==='overbought'&&direction==='SHORT')reasons.push({icon:'⚡',text:`Stoch RSI <strong>overbought</strong> (K: ${stochRsi.k.toFixed(1)}) — confirms short momentum exhaustion.`});
    if(stochRsi.crossover==='bullish_cross'&&direction==='LONG')reasons.push({icon:'🔔',text:`Stoch RSI <strong>bullish crossover</strong> — early long signal.`});
    else if(stochRsi.crossover==='bearish_cross'&&direction==='SHORT')reasons.push({icon:'🔔',text:`Stoch RSI <strong>bearish crossover</strong> — early short signal.`});
  }
  if(adx){
    if(adx.strength==='strong')reasons.push({icon:'💪',text:`ADX <strong>${adx.adx.toFixed(1)}</strong> — strong trend. +DI ${adx.plusDI.toFixed(1)} vs -DI ${adx.minusDI.toFixed(1)}.`});
    else if(adx.strength==='moderate')reasons.push({icon:'📐',text:`ADX <strong>${adx.adx.toFixed(1)}</strong> — moderate trend strength.`});
    else reasons.push({icon:'〰️',text:`ADX <strong>${adx.adx.toFixed(1)}</strong> — ranging market. Use tighter targets.`});
  }
  if(obv){
    if(obv.trend==='accumulation'&&direction==='LONG')reasons.push({icon:'🐂',text:`OBV in <strong>accumulation</strong> — smart money buying. Institutional long support.`});
    else if(obv.trend==='distribution'&&direction==='SHORT')reasons.push({icon:'🐻',text:`OBV in <strong>distribution</strong> — smart money selling. Institutional short pressure.`});
    else if(obv.trend==='accumulation')reasons.push({icon:'⚠️',text:`OBV shows accumulation despite short setup — conflicting signal, reduce size.`});
    else reasons.push({icon:'⚠️',text:`OBV shows distribution despite long setup — conflicting signal, reduce size.`});
  }
  if(volInfo.surge)reasons.push({icon:'📈',text:`Volume <strong>${volInfo.label}</strong> (${volInfo.ratio.toFixed(2)}× avg) — elevated activity confirms move.`});
  else reasons.push({icon:'📊',text:`Volume <strong>${volInfo.label}</strong> (${volInfo.ratio.toFixed(2)}× avg) — moderate, limit entry recommended.`});
  if(atr)reasons.push({icon:'📏',text:`ATR ${fmtPrice(atr.atr)} (${atr.pct.toFixed(2)}%) — SL/TP dynamically sized to current volatility.`});
  if(entryType==='MARKET')reasons.push({icon:'⚡',text:`<strong>Market entry</strong> — confluence aligned, enter at current price.`});
  else reasons.push({icon:'⏳',text:`<strong>Limit entry</strong> — order waits at entry zone, fills on pullback.`});
  reasons.push({icon:'🎯',text:`TP1 = <strong>${rrr1}:1</strong> · TP2 = <strong>${rrr2}:1</strong> RR. Powered by 8-factor confluence scoring.`});
  reasons.push({icon:'🏆',text:`Confluence score: <strong>${confidence}%</strong> — ${confidence>=80?'High confidence':confidence>=65?'Good confidence':'Moderate — size carefully'}.`});
  return reasons;
}
