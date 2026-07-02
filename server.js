const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load local secrets without requiring a dependency. Values already supplied
// by the operating system take precedence over the .env file.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const rawLine of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const split = line.indexOf('=');
    const key = line.slice(0, split).trim();
    let value = line.slice(split + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

const PORT = process.env.PORT || 4318;
const ROOT = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'work');
const DB_FILE = process.env.NEXTMOVE_DB_FILE || path.join(DATA_DIR, 'nextmove-db.json');
const sessions = new Map();
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({users:[],reports:[]}, null, 2));

const readDb = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const writeDb = db => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const id = () => crypto.randomUUID();
const token = () => crypto.randomBytes(24).toString('hex');
const ageFrom = dob => { const d=new Date(dob), n=new Date(); let a=n.getFullYear()-d.getFullYear(); if(n < new Date(n.getFullYear(),d.getMonth(),d.getDate())) a--; return a; };
const hashPassword = password => { const salt=crypto.randomBytes(16).toString('hex'); return salt+':'+crypto.scryptSync(password,salt,64).toString('hex'); };
const checkPassword = (password, stored) => { const [salt,key]=stored.split(':'); return crypto.timingSafeEqual(Buffer.from(key,'hex'),crypto.scryptSync(password,salt,64)); };
function cookies(req){ return Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(x=>x.trim().split('='))); }
function userFor(req){ const uid=sessions.get(cookies(req).session); return uid && readDb().users.find(u=>u.id===uid); }
function sessionCookie(sid){return `session=${sid}; HttpOnly; SameSite=Strict; Path=/${process.env.NODE_ENV==='production'?'; Secure':''}`;}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function httpError(message,status){return Object.assign(new Error(message),{status});}
function body(req, limit=55*1024*1024){return new Promise((resolve,reject)=>{let size=0,parts=[],done=false;req.on('data',c=>{if(done)return;size+=c.length;if(size>limit){done=true;reject(httpError('Upload is too large. Choose a smaller file or shorter clip.',413));req.destroy();}else parts.push(c)});req.on('end',()=>{if(done)return;try{resolve(JSON.parse(Buffer.concat(parts).toString()||'{}'))}catch{reject(httpError('The request could not be read. Please try again.',400))}});req.on('error',e=>{if(!done)reject(e)})});}
function publicUser(u){return {id:u.id,name:u.name,email:u.email,age:u.age,role:u.role,consentStatus:u.consentStatus};}
function dataUrlInfo(value){const match=/^data:([^;,]+);base64,([a-zA-Z0-9+/=]+)$/.exec(String(value||''));if(!match)return null;return {type:match[1].toLowerCase(),bytes:Math.floor(match[2].length*3/4)};}
function short(value,max=200){return String(value||'').trim().slice(0,max);}
function validateAnalyzePayload(payload){
  if(!payload||!['homework','gaming','sports'].includes(payload.mode))throw httpError('Invalid coaching mode.',400);
  payload.meta=payload.meta&&typeof payload.meta==='object'?payload.meta:{};
  for(const key of ['coach','notes','subject','level','game','role','sport','position','jersey'])payload.meta[key]=short(payload.meta[key],key==='notes'?1200:120);
  if(payload.mode==='homework'){
    const info=dataUrlInfo(payload.file?.data),kind=payload.file?.kind;
    if(!info||!['image','pdf'].includes(kind))throw httpError('Choose a valid homework image or PDF.',400);
    if(kind==='pdf'&&info.type!=='application/pdf')throw httpError('The homework PDF format is invalid.',400);
    if(kind==='image'&&!['image/jpeg','image/png','image/webp'].includes(info.type))throw httpError('Homework images must be JPG, PNG, or WebP.',400);
    if(info.bytes>20*1024*1024)throw httpError('Homework files must be 20 MB or smaller.',413);
    payload.file.name=short(payload.file.name,180)||`homework.${kind==='pdf'?'pdf':'jpg'}`;
  }else{
    if(payload.mode==='gaming'&&!payload.meta.game)throw httpError('Add the game name.',400);
    if(payload.mode==='sports'&&(!payload.meta.sport||!payload.meta.position))throw httpError('Add the sport and position.',400);
    if(!Array.isArray(payload.frames)||payload.frames.length<3||payload.frames.length>12)throw httpError('The clip could not be sampled. Please choose a readable clip up to 30 seconds.',400);
    let total=0;
    payload.frames.forEach(frame=>{const info=dataUrlInfo(frame?.data);if(!info||!['image/jpeg','image/png','image/webp'].includes(info.type))throw httpError('One or more video frames are invalid.',400);if(info.bytes>2*1024*1024)throw httpError('A video frame is too large.',413);total+=info.bytes;frame.time=short(frame.time,20)});
    if(total>16*1024*1024)throw httpError('The sampled clip is too large. Please use a shorter or lower-resolution clip.',413);
    if(payload.faceReference){const face=dataUrlInfo(payload.faceReference);if(!face||!['image/jpeg','image/png','image/webp'].includes(face.type))throw httpError('The athlete reference must be a JPG, PNG, or WebP image.',400);if(face.bytes>5*1024*1024)throw httpError('The athlete reference must be 5 MB or smaller.',413);}
  }
  return payload;
}
async function sendConsentEmail(user, consentToken, req){
  const base=process.env.APP_BASE_URL||`http://${req.headers.host}`;
  const url=`${base.replace(/\/$/,'')}/consent.html?token=${consentToken}`;
  if(!process.env.RESEND_API_KEY) return url;
  await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.CONSENT_FROM_EMAIL||'NextMove <onboarding@resend.dev>',to:[user.parentEmail],subject:`Approve ${user.name}'s NextMove account`,html:`<h2>Parent approval requested</h2><p>${user.name} would like to use NextMove for AI coaching.</p><p><a href="${url}">Review and approve</a></p>`})});
  return null;
}

async function analyzeWithAI(payload, user){
  if(!process.env.OPENAI_API_KEY) throw Object.assign(new Error('AI is not configured. Add OPENAI_API_KEY to the server environment.'),{status:503});
  const ageBand=user.age<13?'child':user.age<18?'teen':'adult';
  const common=`You are ${payload.meta?.coach||'NextMove Coach'}, a supportive ${payload.mode} coach. The learner is in the ${ageBand} age band. Be encouraging, specific, concise, and age-appropriate. Do not identify, infer, or mention sensitive traits. Return only valid JSON matching the requested structure.`;
  // JSON mode requires the user input itself to explicitly request JSON.
  let instruction, content=[{type:'input_text',text:'Return the coaching report as valid json only. Do not include markdown or explanatory text outside the json object.'}];
  if(payload.mode==='homework'){
    instruction=`${common} Academic integrity is absolute: do not reveal the final answer, solve the full problem, or complete graded work. Give only the next useful hint, ask one guiding question, and provide a quick understanding check. JSON: {"title":string,"summary":string,"observations":[{"label":string,"detail":string}],"nextStep":string,"question":string,"drill":string}`;
    content.push({type:'input_text',text:`Subject: ${payload.meta.subject||'unspecified'}; level: ${payload.meta.level||'unspecified'}; learner note: ${payload.meta.notes||'none'}. Analyze the uploaded assignment and guide without answering.`});
    if(payload.file.kind==='pdf') content.push({type:'input_file',filename:payload.file.name||'homework.pdf',file_data:payload.file.data});
    else content.push({type:'input_image',image_url:payload.file.data,detail:'high'});
  } else {
    const kind=payload.mode==='gaming'?`Game: ${payload.meta.game}; role/mode: ${payload.meta.role||'unspecified'}`:`Sport: ${payload.meta.sport}; position: ${payload.meta.position}; jersey: ${payload.meta.jersey||'not supplied'}`;
    instruction=`${common} You receive chronological timestamped frames sampled from a short clip. Do not claim to see motion or events absent from the frames. Give evidence-based coaching and acknowledge uncertainty. JSON: {"title":string,"summary":string,"observations":[{"timestamp":string,"label":string,"detail":string}],"strengths":[string],"improvements":[string],"drill":string,"nextFocus":string}`;
    content.push({type:'input_text',text:`${kind}. Goal/note: ${payload.meta.notes||'none'}. Review these chronological frames.`});
    if(payload.mode==='sports'&&payload.faceReference){
      content.push({type:'input_text',text:'Optional visual reference supplied by the user solely to help locate the same athlete in this clip. Use the jersey number when available. Do not identify the person by name or infer any personal or sensitive traits.'});
      content.push({type:'input_image',image_url:payload.faceReference,detail:'low'});
    }
    for(const frame of payload.frames){content.push({type:'input_text',text:`Timestamp ${frame.time}`});content.push({type:'input_image',image_url:frame.data,detail:'low'});}
  }
  let response;try{response=await fetch(process.env.OPENAI_API_URL||'https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-5.4-mini',instructions:instruction,input:[{role:'user',content}],max_output_tokens:1800})})}catch{throw httpError('The AI service could not be reached. Please try again.',502)}
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw Object.assign(new Error(data.error?.message||'AI analysis failed'),{status:502});
  const output=data.output_text || data.output?.flatMap(x=>x.content||[]).find(x=>x.type==='output_text')?.text;
  if(!output) throw Object.assign(new Error('The AI returned no report.'),{status:502});
  const cleaned=output.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{const parsed=JSON.parse(cleaned);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed}catch{throw Object.assign(new Error('The AI report was not valid JSON. Please try the analysis again.'),{status:502})}
}

async function continueCoaching(report, messages, user, coach){
  if(!process.env.OPENAI_API_KEY) throw Object.assign(new Error('AI is not configured. Add OPENAI_API_KEY to the server environment.'),{status:503});
  const mode=report.mode,ageBand=user.age<13?'child':user.age<18?'teen':'adult';
  const integrity=mode==='homework'?'Academic integrity is absolute: never provide the final answer, complete the assignment, or solve graded work. Give one helpful hint at a time, ask guiding questions, and check understanding.':'Only discuss coaching supported by the saved report. Be honest when the report does not contain enough evidence.';
  const instructions=`You are ${coach||'the NextMove coach'}, continuing a ${mode} coaching conversation with ${user.name}, a learner in the ${ageBand} age band. Be warm, concise, specific, and conversational. ${integrity} Do not infer sensitive traits or identify people. The saved coaching report is your source of context.`;
  const recent=(Array.isArray(messages)?messages:[]).slice(-10).filter(m=>['user','assistant'].includes(m.role)&&typeof m.content==='string');
  const transcript=recent.map(m=>`${m.role==='assistant'?'Coach':'Learner'}: ${m.content.slice(0,2000)}`).join('\n');
  const reportText=JSON.stringify(report.report||{}).slice(0,12000);
  const input=`Saved ${mode} coaching report:\n${reportText}\n\nConversation so far:\n${transcript}\n\nReply to the learner's latest question as the coach.`;
  let response;try{response=await fetch(process.env.OPENAI_API_URL||'https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-5.4-mini',instructions,input,max_output_tokens:700})})}catch{throw httpError('The AI service could not be reached. Please try again.',502)}
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw Object.assign(new Error(data.error?.message||'The coach could not reply.'),{status:502});
  const text=data.output_text||data.output?.flatMap(x=>x.content||[]).find(x=>x.type==='output_text')?.text;
  if(!text) throw Object.assign(new Error('The coach returned no reply.'),{status:502});
  return text.trim();
}

async function api(req,res,url){
  try{
    if(req.method==='GET'&&url.pathname==='/api/health') return json(res,200,{ok:true,aiConfigured:!!process.env.OPENAI_API_KEY});
    if(req.method==='POST'&&url.pathname==='/api/signup'){
      const b=await body(req); const age=ageFrom(b.dob);
      if(!b.name||!b.email||!b.password||!b.dob||age<5) return json(res,400,{error:'Please complete all signup fields.'});
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email))) return json(res,400,{error:'Enter a valid email address.'});
      if(b.password.length<8) return json(res,400,{error:'Password must be at least 8 characters.'});
      const db=readDb(); if(db.users.some(u=>u.email.toLowerCase()===b.email.toLowerCase())) return json(res,409,{error:'An account with that email already exists.'});
      if(age<10&&!b.isParent) return json(res,400,{error:'A parent or guardian must create and manage accounts for children under 10.'});
      if(age<13&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.parentEmail||''))) return json(res,400,{error:'A valid parent or guardian email is required for learners under 13.'});
      const consentToken=age<13?token():null;
      const u={id:id(),name:short(b.name,80),email:String(b.email).toLowerCase(),password:hashPassword(b.password),age,role:age<10?'parent-managed':'learner',parentEmail:age<13?String(b.parentEmail).toLowerCase():null,consentStatus:age<13?'pending':'not-required',consentToken,consentExpiresAt:age<13?new Date(Date.now()+48*60*60*1000).toISOString():null,createdAt:new Date().toISOString()}; db.users.push(u);writeDb(db);
      const sid=token();sessions.set(sid,u.id);res.setHeader('Set-Cookie',sessionCookie(sid));
      const consentPreviewUrl=consentToken?await sendConsentEmail(u,consentToken,req):null;
      return json(res,201,{user:publicUser(u),consentPreviewUrl});
    }
    if(req.method==='POST'&&url.pathname==='/api/login'){
      const b=await body(req),db=readDb(),u=db.users.find(x=>x.email===String(b.email||'').toLowerCase());
      if(!u||!checkPassword(b.password||'',u.password)) return json(res,401,{error:'Incorrect email or password.'});
      const sid=token();sessions.set(sid,u.id);res.setHeader('Set-Cookie',sessionCookie(sid));return json(res,200,{user:publicUser(u)});
    }
    if(req.method==='POST'&&url.pathname==='/api/logout'){const sid=cookies(req).session;sessions.delete(sid);res.setHeader('Set-Cookie','session=; Max-Age=0; Path=/');return json(res,200,{ok:true});}
    if(req.method==='GET'&&url.pathname==='/api/me'){const u=userFor(req);return u?json(res,200,{user:publicUser(u)}):json(res,401,{error:'Not signed in'});}
    if(req.method==='POST'&&url.pathname==='/api/consent'){
      const b=await body(req,64*1024),db=readDb(),u=db.users.find(x=>x.consentToken===b.token);
      if(!u||!u.consentExpiresAt||new Date(u.consentExpiresAt)<new Date()) return json(res,404,{error:'This approval link is invalid or expired.'});u.consentStatus='approved';u.consentToken=null;u.consentedAt=new Date().toISOString();writeDb(db);return json(res,200,{ok:true,name:u.name});
    }
    const u=userFor(req); if(!u) return json(res,401,{error:'Please sign in first.'});
    if(req.method==='GET'&&url.pathname==='/api/reports'){const reports=readDb().reports.filter(r=>r.userId===u.id).map(({userId,...r})=>r);return json(res,200,{reports});}
    if(req.method==='POST'&&url.pathname==='/api/chat'){
      if(u.consentStatus==='pending') return json(res,403,{error:'Parent approval is required before using coaching chat.'});
      const b=await body(req),report=readDb().reports.find(r=>r.id===b.reportId&&r.userId===u.id);
      if(!report) return json(res,404,{error:'Coaching report not found.'});
      const reply=await continueCoaching(report,b.messages,u,String(b.coach||'NextMove Coach').slice(0,40));
      return json(res,200,{reply});
    }
    if(req.method==='POST'&&url.pathname==='/api/analyze'){
      if(u.consentStatus==='pending') return json(res,403,{error:'Parent approval is required before uploading.'});
      const b=validateAnalyzePayload(await body(req));
      const report=await analyzeWithAI(b,u); const db=readDb(); const coach=String(b.meta?.coach||'NextMove Coach').slice(0,40);report.coach=coach;const saved={id:id(),userId:u.id,mode:b.mode,coach,title:report.title||`${b.mode} coaching report`,createdAt:new Date().toISOString(),report};db.reports.unshift(saved);writeDb(db);return json(res,200,{report:saved});
    }
    return json(res,404,{error:'Not found'});
  }catch(e){console.error(e);return json(res,e.status||500,{error:e.message||'Something went wrong.'});}
}

function handleRequest(req,res){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; script-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'");
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(url.pathname.startsWith('/api/'))return api(req,res,url);
  const requested=url.pathname==='/'?'/index.html':url.pathname;
  const file=path.normalize(path.join(ROOT,decodeURIComponent(requested)));
  if(!file.startsWith(ROOT)){res.writeHead(403);return res.end('Forbidden')}
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found')}res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':path.extname(file)==='.html'?'no-cache':'public, max-age=3600'});res.end(data)})
}
function createServer(){return http.createServer(handleRequest)}
if(require.main===module)createServer().listen(PORT,()=>console.log(`NextMove running at http://localhost:${PORT}`));
module.exports={createServer,validateAnalyzePayload,dataUrlInfo};
