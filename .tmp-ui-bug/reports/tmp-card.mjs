import fs from 'node:fs';
const t=fs.readFileSync('games/arkhamhorror/src/cards/cards-data.js','utf8');
for (const code of ['05004','05003']) {
  const i=t.indexOf('"code": "'+code+'"');
  console.log('---',code,'at',i);
  if(i<0) continue;
  const seg=t.slice(i, i+3000);
  for (const key of ['nameZh','nameEn','hasReactionPrompt','hasAutoReaction']) {
    const j=seg.indexOf(key);
    if(j>=0) console.log(key, '=>', seg.slice(j, j+80).replace(/\n/g,' '));
  }
  const j=seg.indexOf('"name"'); if(j>=0) console.log('"name" =>', seg.slice(j, j+80));
}
