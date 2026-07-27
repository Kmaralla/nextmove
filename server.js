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
const MINIMUM_AGE = 13;
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({users:[],reports:[]}, null, 2));

const readDb = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const writeDb = db => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const id = () => crypto.randomUUID();
const token = () => crypto.randomBytes(24).toString('hex');
const ageFrom = dob => { const d=new Date(dob), n=new Date(); if(Number.isNaN(d.getTime())||d>n)return NaN; let a=n.getFullYear()-d.getFullYear(); if(n < new Date(n.getFullYear(),d.getMonth(),d.getDate())) a--; return a; };
const hashPassword = password => { const salt=crypto.randomBytes(16).toString('hex'); return salt+':'+crypto.scryptSync(password,salt,64).toString('hex'); };
const checkPassword = (password, stored) => { const [salt,key]=stored.split(':'); return crypto.timingSafeEqual(Buffer.from(key,'hex'),crypto.scryptSync(password,salt,64)); };
function cookies(req){ return Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(x=>x.trim().split('='))); }
function userFor(req){ const uid=sessions.get(cookies(req).session); return uid && readDb().users.find(u=>u.id===uid); }
function sessionCookie(sid){return `session=${sid}; HttpOnly; SameSite=Strict; Path=/${process.env.NODE_ENV==='production'?'; Secure':''}`;}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function httpError(message,status){return Object.assign(new Error(message),{status});}
function aiReachError(error){
  const nested=Array.isArray(error?.cause?.errors)?error.cause.errors.flatMap(e=>[e?.message,e?.code,e?.address].filter(Boolean)):[];
  const parts=[error?.message,error?.cause?.message,error?.cause?.code,...nested].filter(Boolean);
  const detail=parts.length?` (${parts.join(' · ')})`:'';
  return httpError(`The AI service could not be reached. Please check internet/DNS/firewall/proxy access to api.openai.com and try again.${detail}`,502);
}
function body(req, limit=55*1024*1024){return new Promise((resolve,reject)=>{let size=0,parts=[],done=false;req.on('data',c=>{if(done)return;size+=c.length;if(size>limit){done=true;reject(httpError('Upload is too large. Choose a smaller file or shorter clip.',413));req.destroy();}else parts.push(c)});req.on('end',()=>{if(done)return;try{resolve(JSON.parse(Buffer.concat(parts).toString()||'{}'))}catch{reject(httpError('The request could not be read. Please try again.',400))}});req.on('error',e=>{if(!done)reject(e)})});}
function publicUser(u){return {id:u.id,name:u.name,email:u.email,age:u.age,role:u.role};}
function canUseCoaching(u){return u.age>=MINIMUM_AGE;}
function normalizeDb(db){for(const key of ['users','reports','friendRequests','friendships','friendMessages','parties','partyMessages','safetyReports','blockedUsers'])if(!Array.isArray(db[key]))db[key]=[];return db;}
function readAppDb(){return normalizeDb(readDb());}
function isBlocked(db,a,b){return db.blockedUsers.some(x=>(x.userId===a&&x.blockedId===b)||(x.userId===b&&x.blockedId===a));}
function friendIds(db,userId){return db.friendships.filter(f=>f.users.includes(userId)).map(f=>f.users.find(id=>id!==userId)).filter(fid=>!isBlocked(db,userId,fid));}
function areFriends(db,a,b){return !isBlocked(db,a,b)&&db.friendships.some(f=>f.users.includes(a)&&f.users.includes(b));}
function friendChatId(a,b){return [a,b].sort().join(':');}
function partyFor(db,userId){let party=db.parties.find(p=>p.memberIds?.includes(userId)&&p.ownerId!==userId)||db.parties.find(p=>p.ownerId===userId||p.memberIds?.includes(userId)||p.invitedIds?.includes(userId));if(!party){party={id:id(),ownerId:userId,memberIds:[userId],invitedIds:[],reportIds:[],createdAt:new Date().toISOString()};db.parties.push(party)}party.memberIds=[...new Set([party.ownerId,...(party.memberIds||[])])];party.invitedIds=[...new Set(party.invitedIds||[])].filter(x=>!party.memberIds.includes(x));party.reportIds=[...new Set(party.reportIds||[])];return party;}
function accessBlockMessage(u){
  return u.age<MINIMUM_AGE
    ? 'NextMove is available only for learners age 13 and older in this public MVP.'
    : 'This account is not ready for coaching.';
}
function dataUrlInfo(value){const match=/^data:([^;,]+);base64,([a-zA-Z0-9+/=]+)$/.exec(String(value||''));if(!match)return null;return {type:match[1].toLowerCase(),bytes:Math.floor(match[2].length*3/4)};}
function short(value,max=200){return String(value||'').trim().slice(0,max);}
function validateAnalyzePayload(payload){
  if(!payload||!['homework','gaming','sports'].includes(payload.mode))throw httpError('Invalid coaching mode.',400);
  payload.meta=payload.meta&&typeof payload.meta==='object'?payload.meta:{};
  for(const key of ['coach','notes','subject','level','game','role','sport','position','jersey','jerseyName'])payload.meta[key]=short(payload.meta[key],key==='notes'?1200:120);
  payload.meta.hasJersey=!!payload.meta.hasJersey;
  payload.meta.hasJerseyName=!!payload.meta.hasJerseyName;
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
    if(payload.mode==='sports'&&payload.meta.hasJersey&&!payload.meta.jersey)throw httpError('Add your jersey number, or uncheck “I have a jersey number.”',400);
    if(payload.mode==='sports'&&payload.meta.hasJerseyName&&!payload.meta.jerseyName)throw httpError('Add your jersey name, or uncheck “I have a jersey name.”',400);
    if(!Array.isArray(payload.frames)||payload.frames.length<3||payload.frames.length>12)throw httpError('The clip could not be sampled. Please choose a readable clip up to 30 seconds.',400);
    let total=0;
    payload.frames.forEach(frame=>{const info=dataUrlInfo(frame?.data);if(!info||!['image/jpeg','image/png','image/webp'].includes(info.type))throw httpError('One or more video frames are invalid.',400);if(info.bytes>2*1024*1024)throw httpError('A video frame is too large.',413);total+=info.bytes;frame.time=short(frame.time,20)});
    if(total>16*1024*1024)throw httpError('The sampled clip is too large. Please use a shorter or lower-resolution clip.',413);
    if(payload.faceReference)throw httpError('Athlete reference photos are not accepted in the public MVP. Use jersey number and visible clip context instead.',400);
  }
  return payload;
}
async function analyzeWithAI(payload, user){
  if(!process.env.OPENAI_API_KEY) throw Object.assign(new Error('AI is not configured. Add OPENAI_API_KEY to the server environment.'),{status:503});
  const ageBand=user.age<18?'teen':'adult';
  const nowText=new Intl.DateTimeFormat('en-US',{dateStyle:'long',timeZone:'America/New_York'}).format(new Date());
  const common=`Current date: ${nowText}. Treat events before this date as already happened. If asked about recent sports, games, releases, teams, tournaments, or public events and you are not certain, say you may be out of date instead of guessing. You are ${payload.meta?.coach||'NextMove Coach'}, a supportive ${payload.mode} coach. The learner is in the ${ageBand} age band. Be encouraging, specific, concise, and age-appropriate. Do not identify real-world people, infer sensitive traits, or mention sensitive traits. Return only valid JSON matching the requested structure.`;
  // JSON mode requires the user input itself to explicitly request JSON.
  let instruction, content=[{type:'input_text',text:'Return the coaching report as valid json only. Do not include markdown or explanatory text outside the json object.'}];
  if(payload.mode==='homework'){
    instruction=`${common} Academic integrity is absolute: do not reveal the final answer, solve the full problem, or complete graded work. Give only the next useful hint, ask one guiding question, and provide a quick understanding check. JSON: {"title":string,"summary":string,"observations":[{"label":string,"detail":string}],"nextStep":string,"question":string,"drill":string}`;
    content.push({type:'input_text',text:`Subject: ${payload.meta.subject||'unspecified'}; level: ${payload.meta.level||'unspecified'}; learner note: ${payload.meta.notes||'none'}. Analyze the uploaded assignment and guide without answering.`});
    if(payload.file.kind==='pdf') content.push({type:'input_file',filename:payload.file.name||'homework.pdf',file_data:payload.file.data});
    else content.push({type:'input_image',image_url:payload.file.data,detail:'high'});
  } else {
    const kind=payload.mode==='gaming'?`Game: ${payload.meta.game}; role/mode: ${payload.meta.role||'unspecified'}`:`Sport: ${payload.meta.sport}; position: ${payload.meta.position}; jersey number: ${payload.meta.jersey||'not supplied'}; jersey name/text: ${payload.meta.jerseyName||'not supplied'}`;
    instruction=`${common} You receive chronological timestamped frames sampled from a short clip. Do not claim to see motion or events absent from the frames. Give evidence-based coaching and acknowledge uncertainty. Always include at least two concrete improvements for gaming and sports, written as actions the learner can practice next. For sports, use the jersey number and jersey name/text only to distinguish the learner's player from other visible players; if the jersey details are not visible or multiple players could match, clearly say you are unsure. Do not identify the learner by face, legal name, full identity, school, team, or other real-world identity. For sports, do not diagnose injuries, provide medical advice, or recommend playing through pain; suggest asking a qualified adult, coach, clinician, or professional when pain or injury is involved. JSON: {"title":string,"summary":string,"observations":[{"timestamp":string,"label":string,"detail":string}],"strengths":[string],"improvements":[string],"drill":string,"nextFocus":string}`;
    content.push({type:'input_text',text:`${kind}. Goal/note: ${payload.meta.notes||'none'}. Review these chronological frames.`});
    for(const frame of payload.frames){content.push({type:'input_text',text:`Timestamp ${frame.time}`});content.push({type:'input_image',image_url:frame.data,detail:'low'});}
  }
  let response;try{response=await fetch(process.env.OPENAI_API_URL||'https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-5.4-mini',instructions:instruction,input:[{role:'user',content}],max_output_tokens:1800})})}catch(error){throw aiReachError(error)}
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw Object.assign(new Error(data.error?.message||'AI analysis failed'),{status:502});
  const output=data.output_text || data.output?.flatMap(x=>x.content||[]).find(x=>x.type==='output_text')?.text;
  if(!output) throw Object.assign(new Error('The AI returned no report.'),{status:502});
  const cleaned=output.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{const parsed=JSON.parse(cleaned);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error();return parsed}catch{throw Object.assign(new Error('The AI report was not valid JSON. Please try the analysis again.'),{status:502})}
}

async function continueCoaching(report, messages, user, coach){
  if(!process.env.OPENAI_API_KEY) throw Object.assign(new Error('AI is not configured. Add OPENAI_API_KEY to the server environment.'),{status:503});
  const mode=report.mode,ageBand=user.age<18?'teen':'adult';
  const integrity=mode==='homework'?'Academic integrity is absolute: never provide the final answer, complete the assignment, or solve graded work. If the learner asks for the answer, refuse briefly and give a hint, guiding question, or concept explanation instead.':'Only discuss coaching supported by the saved report. Be honest when the report does not contain enough evidence.';
  const sportsSafety=mode==='sports'?'Sports safety: do not diagnose injuries, provide medical advice, recommend playing through pain, or replace a coach/clinician. If pain or injury is mentioned, tell the learner to stop and ask a qualified adult, coach, clinician, or professional.':'':
  const nowText=new Intl.DateTimeFormat('en-US',{dateStyle:'long',timeZone:'America/New_York'}).format(new Date());
  const instructions=`Current date: ${nowText}. Treat events before this date as already happened. If asked about recent sports, games, releases, teams, tournaments, or public events and you are not certain, say you may be out of date instead of guessing. You are ${coach||'the NextMove coach'}, continuing a ${mode} coaching conversation with ${user.name}, a learner in the ${ageBand} age band. Be warm, concise, specific, and conversational. ${integrity} ${sportsSafety} Do not infer sensitive traits or identify real-world people. The saved coaching report is your source of context.`;
  const recent=(Array.isArray(messages)?messages:[]).slice(-10).filter(m=>['user','assistant'].includes(m.role)&&typeof m.content==='string');
  const transcript=recent.map(m=>`${m.role==='assistant'?'Coach':'Learner'}: ${m.content.slice(0,2000)}`).join('\n');
  const reportText=JSON.stringify(report.report||{}).slice(0,12000);
  const input=`Saved ${mode} coaching report:\n${reportText}\n\nConversation so far:\n${transcript}\n\nReply to the learner's latest question as the coach.`;
  let response;try{response=await fetch(process.env.OPENAI_API_URL||'https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-5.4-mini',instructions,input,max_output_tokens:700})})}catch(error){throw aiReachError(error)}
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
      if(!b.name||!b.email||!b.password||!b.dob||!Number.isFinite(age)||age<5) return json(res,400,{error:'Please enter a valid date of birth that is not in the future.'});
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email))) return json(res,400,{error:'Enter a valid email address.'});
      if(b.password.length<8) return json(res,400,{error:'Password must be at least 8 characters.'});
      if(age<MINIMUM_AGE) return json(res,403,{error:'NextMove is available only for learners age 13 and older in this public MVP.'});
      if(age<18&&b.guardianPermission!==true) return json(res,400,{error:'Learners ages 13–17 must confirm they have parent or guardian permission.'});
      if(b.acceptTerms!==true) return json(res,400,{error:'You must confirm you are 13+ and agree to the Terms and Privacy Notice.'});
      const db=readDb(); if(db.users.some(u=>u.email.toLowerCase()===b.email.toLowerCase())) return json(res,409,{error:'An account with that email already exists.'});
      const now=new Date().toISOString();
      const u={id:id(),name:short(b.name,80),email:String(b.email).toLowerCase(),password:hashPassword(b.password),age,role:'learner',guardianPermissionConfirmed:age<18,termsAcceptedAt:now,privacyAcceptedAt:now,termsVersion:'2026-07-26',createdAt:now}; db.users.push(u);writeDb(db);
      const sid=token();sessions.set(sid,u.id);res.setHeader('Set-Cookie',sessionCookie(sid));
      return json(res,201,{user:publicUser(u)});
    }
    if(req.method==='POST'&&url.pathname==='/api/login'){
      const b=await body(req),db=readDb(),u=db.users.find(x=>x.email===String(b.email||'').toLowerCase());
      if(!u||!checkPassword(b.password||'',u.password)) return json(res,401,{error:'Incorrect email or password.'});
      const sid=token();sessions.set(sid,u.id);res.setHeader('Set-Cookie',sessionCookie(sid));return json(res,200,{user:publicUser(u)});
    }
    if(req.method==='POST'&&url.pathname==='/api/logout'){const sid=cookies(req).session;sessions.delete(sid);res.setHeader('Set-Cookie','session=; Max-Age=0; Path=/');return json(res,200,{ok:true});}
    if(req.method==='GET'&&url.pathname==='/api/me'){const u=userFor(req);return u?json(res,200,{user:publicUser(u)}):json(res,401,{error:'Not signed in'});}
    const u=userFor(req); if(!u) return json(res,401,{error:'Please sign in first.'});
    if(req.method==='GET'&&url.pathname==='/api/reports'){const reports=readAppDb().reports.filter(r=>r.userId===u.id).map(({userId,...r})=>r);return json(res,200,{reports});}
    if(req.method==='DELETE'&&url.pathname.startsWith('/api/reports/')){
      const reportId=decodeURIComponent(url.pathname.slice('/api/reports/'.length));
      const db=readAppDb(),before=db.reports.length;
      db.reports=db.reports.filter(r=>!(r.id===reportId&&r.userId===u.id));
      if(db.reports.length===before) return json(res,404,{error:'Coaching report not found.'});
      db.parties.forEach(p=>p.reportIds=(p.reportIds||[]).filter(id=>id!==reportId));
      writeDb(db);return json(res,200,{ok:true});
    }
    if(req.method==='GET'&&url.pathname==='/api/friends'){
      const db=readAppDb(),ids=friendIds(db,u.id),users=Object.fromEntries(db.users.map(user=>[user.id,user]));
      const friends=ids.map(fid=>users[fid]).filter(Boolean).map(friend=>({id:friend.id,name:friend.name,email:friend.email,online:[...sessions.values()].includes(friend.id)}));
      const incoming=db.friendRequests.filter(r=>r.to===u.id&&r.status==='pending').map(r=>({id:r.id,from:publicUser(users[r.from]),createdAt:r.createdAt})).filter(r=>r.from);
      const outgoing=db.friendRequests.filter(r=>r.from===u.id&&r.status==='pending').map(r=>({id:r.id,to:publicUser(users[r.to]),createdAt:r.createdAt})).filter(r=>r.to);
      const partyInvites=db.parties.filter(p=>p.invitedIds?.includes(u.id)).map(p=>({id:p.id,from:publicUser(users[p.ownerId])})).filter(p=>p.from);
      return json(res,200,{friends,incoming,outgoing,partyInvites});
    }
    if(req.method==='POST'&&url.pathname==='/api/friends/invite'){
      const b=await body(req),email=String(b.email||'').trim().toLowerCase(),db=readAppDb(),target=db.users.find(x=>x.email===email);
      if(!target) return json(res,404,{error:'No NextMove account found for that email.'});
      if(target.id===u.id) return json(res,400,{error:'You cannot invite yourself.'});
      if(areFriends(db,u.id,target.id)) return json(res,409,{error:'You are already friends.'});
      const existing=db.friendRequests.find(r=>r.status==='pending'&&((r.from===u.id&&r.to===target.id)||(r.from===target.id&&r.to===u.id)));
      if(existing) return json(res,200,{request:existing});
      const request={id:id(),from:u.id,to:target.id,status:'pending',createdAt:new Date().toISOString()};db.friendRequests.push(request);writeDb(db);return json(res,201,{request});
    }
    if(req.method==='POST'&&url.pathname==='/api/friends/respond'){
      const b=await body(req),db=readAppDb(),request=db.friendRequests.find(r=>r.id===b.requestId&&r.to===u.id&&r.status==='pending');
      if(!request) return json(res,404,{error:'Friend request not found.'});
      request.status=b.accept===true?'accepted':'declined';request.respondedAt=new Date().toISOString();
      if(b.accept===true&&!areFriends(db,request.from,request.to))db.friendships.push({id:id(),users:[request.from,request.to],createdAt:new Date().toISOString()});
      writeDb(db);return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/friends/remove'){
      const b=await body(req),db=readAppDb(),friendId=String(b.friendId||'');
      if(!friendId||!db.friendships.some(f=>f.users.includes(u.id)&&f.users.includes(friendId))) return json(res,404,{error:'Friend not found.'});
      db.friendships=db.friendships.filter(f=>!(f.users.includes(u.id)&&f.users.includes(friendId)));
      db.friendRequests=db.friendRequests.filter(r=>!((r.from===u.id&&r.to===friendId)||(r.from===friendId&&r.to===u.id)));
      db.friendMessages=db.friendMessages.filter(m=>m.chatId!==friendChatId(u.id,friendId));
      db.parties.forEach(p=>{p.memberIds=(p.memberIds||[]).filter(id=>id!==friendId||p.ownerId===friendId);p.invitedIds=(p.invitedIds||[]).filter(id=>id!==friendId)});
      writeDb(db);return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/friends/block'){
      const b=await body(req),db=readAppDb(),blockedId=String(b.friendId||b.userId||'');
      if(!blockedId||blockedId===u.id) return json(res,400,{error:'Choose a valid user to block.'});
      if(!db.blockedUsers.some(x=>x.userId===u.id&&x.blockedId===blockedId))db.blockedUsers.push({id:id(),userId:u.id,blockedId,createdAt:new Date().toISOString()});
      db.friendships=db.friendships.filter(f=>!(f.users.includes(u.id)&&f.users.includes(blockedId)));
      db.friendMessages=db.friendMessages.filter(m=>m.chatId!==friendChatId(u.id,blockedId));
      db.parties.forEach(p=>{p.memberIds=(p.memberIds||[]).filter(id=>id!==blockedId||p.ownerId===blockedId);p.invitedIds=(p.invitedIds||[]).filter(id=>id!==blockedId)});
      writeDb(db);return json(res,200,{ok:true});
    }
    if(req.method==='GET'&&url.pathname==='/api/friends/chat'){
      const friendId=url.searchParams.get('friendId'),db=readAppDb();
      if(!friendId||!areFriends(db,u.id,friendId)) return json(res,403,{error:'You can only chat with accepted friends.'});
      const chatId=friendChatId(u.id,friendId),messages=db.friendMessages.filter(m=>m.chatId===chatId).slice(-80);
      return json(res,200,{messages});
    }
    if(req.method==='POST'&&url.pathname==='/api/friends/chat'){
      const b=await body(req),db=readAppDb(),friendId=String(b.friendId||''),text=short(b.text,1000);
      if(!text) return json(res,400,{error:'Type a message first.'});
      if(!areFriends(db,u.id,friendId)) return json(res,403,{error:'You can only chat with accepted friends.'});
      const message={id:id(),chatId:friendChatId(u.id,friendId),from:u.id,to:friendId,text,createdAt:new Date().toISOString()};db.friendMessages.push(message);writeDb(db);return json(res,201,{message});
    }
    if(req.method==='GET'&&url.pathname==='/api/party'){
      const db=readAppDb(),users=Object.fromEntries(db.users.map(user=>[user.id,user])),party=partyFor(db,u.id),isMember=party.memberIds.includes(u.id);
      const members=(party.memberIds||[]).map(uid=>users[uid]).filter(Boolean).map(user=>({id:user.id,name:user.name,email:user.email,online:[...sessions.values()].includes(user.id)}));
      const invited=(party.invitedIds||[]).map(uid=>users[uid]).filter(Boolean).map(publicUser);
      const reports=(isMember?(party.reportIds||[]):[]).map(rid=>db.reports.find(r=>r.id===rid)).filter(Boolean).map(({userId,...r})=>({...r,owner:users[userId]?.name||'Friend'}));
      const messages=isMember?db.partyMessages.filter(m=>m.partyId===party.id).slice(-80).map(m=>({...m,fromName:users[m.from]?.name||'Friend'})):[];
      writeDb(db);return json(res,200,{party:{id:party.id,ownerId:party.ownerId,isMember,members,invited,reports,messages}});
    }
    if(req.method==='POST'&&url.pathname==='/api/party/invite'){
      const b=await body(req),db=readAppDb(),friendId=String(b.friendId||''),party=partyFor(db,u.id);
      if(party.ownerId!==u.id) return json(res,403,{error:'Only the party owner can invite friends.'});
      if(!areFriends(db,u.id,friendId)) return json(res,403,{error:'Invite accepted friends only.'});
      if(!party.memberIds.includes(friendId)&&!party.invitedIds.includes(friendId))party.invitedIds.push(friendId);
      writeDb(db);return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/party/respond'){
      const b=await body(req),db=readAppDb(),party=db.parties.find(p=>p.id===b.partyId&&p.invitedIds?.includes(u.id));
      if(!party) return json(res,404,{error:'Party invite not found.'});
      party.invitedIds=party.invitedIds.filter(uid=>uid!==u.id);
      if(b.accept===true&&!party.memberIds.includes(u.id))party.memberIds.push(u.id);
      writeDb(db);return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/party/leave'){
      const db=readAppDb(),party=db.parties.find(p=>p.memberIds?.includes(u.id)||p.ownerId===u.id);
      if(!party) return json(res,404,{error:'Party not found.'});
      party.memberIds=(party.memberIds||[]).filter(id=>id!==u.id);
      party.invitedIds=(party.invitedIds||[]).filter(id=>id!==u.id);
      if(party.ownerId===u.id)party.ownerId=party.memberIds[0]||null;
      db.parties=db.parties.filter(p=>p.ownerId&&p.memberIds?.length);
      writeDb(db);return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/party/share'){
      const b=await body(req),db=readAppDb(),party=partyFor(db,u.id),report=db.reports.find(r=>r.id===b.reportId&&r.userId===u.id);
      if(!report) return json(res,404,{error:'Coaching report not found.'});
      if(!party.memberIds.includes(u.id)) return json(res,403,{error:'Join the party before sharing.'});
      if(!party.reportIds.includes(report.id))party.reportIds.unshift(report.id);
      writeDb(db);return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/party/message'){
      const b=await body(req),db=readAppDb(),party=partyFor(db,u.id),text=short(b.text,1000);
      if(!party.memberIds.includes(u.id)) return json(res,403,{error:'Join the party before chatting.'});
      if(!text) return json(res,400,{error:'Type a message first.'});
      db.partyMessages.push({id:id(),partyId:party.id,from:u.id,text,createdAt:new Date().toISOString()});writeDb(db);return json(res,201,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/safety/report'){
      const b=await body(req),db=readAppDb(),kind=String(b.kind||''),messageId=String(b.messageId||''),reason=short(b.reason||'User reported this content.',500);
      if(!['friend-message','party-message','user'].includes(kind)) return json(res,400,{error:'Choose something valid to report.'});
      let targetUserId=short(b.targetUserId||'',80),removed=false;
      if(kind==='friend-message'){
        const message=db.friendMessages.find(m=>m.id===messageId&&(m.from===u.id||m.to===u.id));
        if(!message) return json(res,404,{error:'Message not found.'});
        targetUserId=message.from===u.id?message.to:message.from;
        db.friendMessages=db.friendMessages.filter(m=>m.id!==messageId);removed=true;
      }
      if(kind==='party-message'){
        const party=partyFor(db,u.id),message=db.partyMessages.find(m=>m.id===messageId&&m.partyId===party.id);
        if(!message) return json(res,404,{error:'Message not found.'});
        targetUserId=message.from;
        db.partyMessages=db.partyMessages.filter(m=>m.id!==messageId);removed=true;
      }
      db.safetyReports.push({id:id(),reporterId:u.id,targetUserId,kind,messageId,reason,removed,createdAt:new Date().toISOString()});
      writeDb(db);return json(res,200,{ok:true});
    }
    if(req.method==='DELETE'&&url.pathname==='/api/account'){
      const db=readAppDb();
      db.reports=db.reports.filter(r=>r.userId!==u.id);
      db.users=db.users.filter(x=>x.id!==u.id);
      db.friendRequests=db.friendRequests.filter(r=>r.from!==u.id&&r.to!==u.id);
      db.friendships=db.friendships.filter(f=>!f.users.includes(u.id));
      db.friendMessages=db.friendMessages.filter(m=>m.from!==u.id&&m.to!==u.id);
      db.blockedUsers=db.blockedUsers.filter(b=>b.userId!==u.id&&b.blockedId!==u.id);
      db.safetyReports=db.safetyReports.filter(r=>r.reporterId!==u.id&&r.targetUserId!==u.id);
      db.parties=db.parties.filter(p=>p.ownerId!==u.id).map(p=>({...p,memberIds:p.memberIds.filter(id=>id!==u.id),invitedIds:p.invitedIds.filter(id=>id!==u.id)}));
      db.partyMessages=db.partyMessages.filter(m=>m.from!==u.id);
      for(const [sid,uid] of sessions.entries()) if(uid===u.id) sessions.delete(sid);
      writeDb(db);res.setHeader('Set-Cookie','session=; Max-Age=0; Path=/');return json(res,200,{ok:true});
    }
    if(req.method==='POST'&&url.pathname==='/api/chat'){
      if(!canUseCoaching(u)) return json(res,403,{error:accessBlockMessage(u)});
      const b=await body(req),report=readAppDb().reports.find(r=>r.id===b.reportId&&r.userId===u.id);
      if(!report) return json(res,404,{error:'Coaching report not found.'});
      const reply=await continueCoaching(report,b.messages,u,String(b.coach||'NextMove Coach').slice(0,40));
      return json(res,200,{reply});
    }
    if(req.method==='POST'&&url.pathname==='/api/analyze'){
      if(!canUseCoaching(u)) return json(res,403,{error:accessBlockMessage(u)});
      const b=validateAnalyzePayload(await body(req));
      const report=await analyzeWithAI(b,u); const db=readAppDb(); const coach=String(b.meta?.coach||'NextMove Coach').slice(0,40);report.coach=coach;const saved={id:id(),userId:u.id,mode:b.mode,coach,title:report.title||`${b.mode} coaching report`,createdAt:new Date().toISOString(),report};db.reports.unshift(saved);writeDb(db);return json(res,200,{report:saved});
    }
    return json(res,404,{error:'Not found'});
  }catch(e){if(!e.status||e.status>=500)console.error(e);return json(res,e.status||500,{error:e.message||'Something went wrong.'});}
}

function handleRequest(req,res){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; script-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'");
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(url.pathname.startsWith('/api/'))return api(req,res,url);
  const requested=url.pathname==='/'?'/index.html':url.pathname;
  const file=path.normalize(path.join(ROOT,decodeURIComponent(requested)));
  if(!file.startsWith(ROOT)){res.writeHead(403);return res.end('Forbidden')}
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found')}const ext=path.extname(file);res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':['.html','.js','.css'].includes(ext)?'no-cache':'public, max-age=3600'});res.end(data)})
}
function createServer(){return http.createServer(handleRequest)}
if(require.main===module)createServer().listen(PORT,()=>console.log(`NextMove running at http://localhost:${PORT}`));
module.exports={createServer,validateAnalyzePayload,dataUrlInfo};
