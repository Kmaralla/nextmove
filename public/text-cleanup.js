(function(){
  const cp1252 = new Map([
    [0x20AC,0x80],[0x201A,0x82],[0x0192,0x83],[0x201E,0x84],[0x2026,0x85],[0x2020,0x86],[0x2021,0x87],[0x02C6,0x88],[0x2030,0x89],[0x0160,0x8A],[0x2039,0x8B],[0x0152,0x8C],[0x017D,0x8E],
    [0x2018,0x91],[0x2019,0x92],[0x201C,0x93],[0x201D,0x94],[0x2022,0x95],[0x2013,0x96],[0x2014,0x97],[0x02DC,0x98],[0x2122,0x99],[0x0161,0x9A],[0x203A,0x9B],[0x0153,0x9C],[0x017E,0x9E],[0x0178,0x9F]
  ]);
  const badRun = /[\u0080-\u00FF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2018\u2019\u201A\u201C\u201D\u201E\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]{2,}/g;
  function byteFor(ch){
    const cp = ch.codePointAt(0);
    if(cp <= 0xff) return cp;
    return cp1252.get(cp);
  }
  function decodeRun(run){
    const bytes = [];
    for(const ch of run){
      const b = byteFor(ch);
      if(b == null) return run;
      bytes.push(b);
    }
    try{
      const decoded = new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(bytes));
      return decoded || run;
    }catch{
      return run;
    }
  }
  function cleanText(value){
    return String(value || '').replace(badRun, decodeRun);
  }
  function cleanNode(root){
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while(walker.nextNode()) nodes.push(walker.currentNode);
    for(const node of nodes){
      const next = cleanText(node.nodeValue);
      if(next !== node.nodeValue) node.nodeValue = next;
    }
    const spark = document.querySelector('.promise .spark');
    if(spark) spark.textContent = '';
  }
  function cleanSoon(){setTimeout(()=>cleanNode(document.body),0)}
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', cleanSoon);
  else cleanSoon();
  new MutationObserver(cleanSoon).observe(document.documentElement,{subtree:true,childList:true,characterData:true});
})();
