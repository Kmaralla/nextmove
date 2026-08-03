const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const path=require('node:path');
const os=require('node:os');

process.env.OPENAI_API_KEY='test-key';
process.env.NEXTMOVE_DB_FILE=path.join(os.tmpdir(),`nextmove-test-${process.pid}-${Date.now()}.json`);
const {createServer,validateAnalyzePayload}=require('../server');

const image='data:image/jpeg;base64,aGVsbG8=';
const pdf='data:application/pdf;base64,aGVsbG8=';
const frames=()=>[0,1,2].map(i=>({time:`0:0${i}`,data:image}));
const dobForAge=age=>`${new Date().getFullYear()-age}-01-15`;
const futureDob=()=>`${new Date().getFullYear()+1}-01-15`;
let app,ai,base;

function listen(server){return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)))}
function close(server){return new Promise(resolve=>server.close(resolve))}
async function call(route,{method='GET',body,cookie}={}){
  const response=await fetch(base+route,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json().catch(()=>null),cookie:response.headers.get('set-cookie'),headers:response.headers};
}

test.before(async()=>{
  ai=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const request=JSON.parse(raw||'{}');const chat=typeof request.input==='string';const report={title:'Test coaching report',summary:'Specific feedback from the supplied material.',observations:[{label:'Visible moment',detail:'Use this evidence to choose the next step.'}],strengths:['Effort'],improvements:['Timing'],drill:'Practice one focused repetition.',nextFocus:'Repeat and review.'};res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({output_text:chat?'Keep working through the next step.':JSON.stringify(report)}))})});
  const aiPort=await listen(ai);process.env.OPENAI_API_URL=`http://127.0.0.1:${aiPort}`;
  app=createServer();const port=await listen(app);base=`http://127.0.0.1:${port}`;
});
test.after(async()=>{await close(app);await close(ai)});

test('rejects malformed coaching payloads at the server boundary',()=>{
  assert.throws(()=>validateAnalyzePayload({mode:'homework',meta:{},file:{kind:'image',data:'not-data'}}),/valid homework/);
  assert.throws(()=>validateAnalyzePayload({mode:'gaming',meta:{game:''},frames:frames()}),/game name/);
  assert.throws(()=>validateAnalyzePayload({mode:'sports',meta:{sport:'Soccer'},frames:frames()}),/sport and position/);
});

test('adult account can analyze homework, gaming, and sports safely',async()=>{
  const noTerms=await call('/api/signup',{method:'POST',body:{name:'No Terms',email:'no-terms@example.test',password:'password123',dob:dobForAge(18)}});
  assert.equal(noTerms.status,400);assert.match(noTerms.data.error,/Terms and Privacy/);
  const future=await call('/api/signup',{method:'POST',body:{name:'Future User',email:'future@example.test',password:'password123',dob:futureDob(),acceptTerms:true}});
  assert.equal(future.status,400);assert.match(future.data.error,/date of birth/);
  const signup=await call('/api/signup',{method:'POST',body:{name:'Test Learner',username:'testlearner',email:'adult@example.test',password:'password123',dob:dobForAge(18),acceptTerms:true}});
  assert.equal(signup.status,201);const cookie=signup.cookie.split(';')[0];
  const home=await call('/api/analyze',{method:'POST',cookie,body:{mode:'homework',meta:{subject:'Math',level:'College',coach:'Maya'},file:{name:'work.pdf',kind:'pdf',data:pdf}}});
  assert.equal(home.status,200);assert.equal(home.data.report.mode,'homework');
  const chat=await call('/api/chat',{method:'POST',cookie,body:{reportId:home.data.report.id,coach:'Maya',messages:[{role:'user',content:'Can you explain the first hint another way?'}]}});
  assert.equal(chat.status,200);assert.match(chat.data.reply,/next step/i);
  const gaming=await call('/api/analyze',{method:'POST',cookie,body:{mode:'gaming',meta:{game:'Rocket League',role:'Ranked',coach:'Byte'},frames:frames()}});
  assert.equal(gaming.status,200);assert.equal(gaming.data.report.mode,'gaming');
  const sportsFace=await call('/api/analyze',{method:'POST',cookie,body:{mode:'sports',meta:{sport:'Soccer',position:'Forward',coach:'Kai'},frames:frames(),faceReference:image}});
  assert.equal(sportsFace.status,400);assert.match(sportsFace.data.error,/reference photos are not accepted/);
  const sports=await call('/api/analyze',{method:'POST',cookie,body:{mode:'sports',meta:{sport:'Soccer',position:'Forward',coach:'Kai'},frames:frames()}});
  assert.equal(sports.status,200);assert.equal(sports.data.report.mode,'sports');
  const reports=await call('/api/reports',{cookie});assert.equal(reports.status,200);assert.equal(reports.data.reports.length,3);
  const teenNoGuardian=await call('/api/signup',{method:'POST',body:{name:'Teen No Guardian',email:'teen-no-guardian@example.test',password:'password123',dob:dobForAge(16),acceptTerms:true}});
  assert.equal(teenNoGuardian.status,400);assert.match(teenNoGuardian.data.error,/guardian permission/);
  const friendSignup=await call('/api/signup',{method:'POST',body:{name:'Study Friend',username:'studyfriend',email:'friend@example.test',password:'password123',dob:dobForAge(16),acceptTerms:true,guardianPermission:true}});
  assert.equal(friendSignup.status,201);const friendCookie=friendSignup.cookie.split(';')[0];
  const invite=await call('/api/friends/invite',{method:'POST',cookie,body:{username:'studyfriend'}});assert.equal(invite.status,201);
  const friendInbox=await call('/api/friends',{cookie:friendCookie});assert.equal(friendInbox.data.incoming.length,1);
  const accept=await call('/api/friends/respond',{method:'POST',cookie:friendCookie,body:{requestId:friendInbox.data.incoming[0].id,accept:true}});assert.equal(accept.status,200);
  const friendChat=await call('/api/friends/chat',{method:'POST',cookie,body:{friendId:friendSignup.data.user.id,text:'Want to review this together?'}});assert.equal(friendChat.status,201);
  const partyInvite=await call('/api/party/invite',{method:'POST',cookie,body:{friendId:friendSignup.data.user.id}});assert.equal(partyInvite.status,200);
  const friendPartyInvites=await call('/api/friends',{cookie:friendCookie});assert.equal(friendPartyInvites.data.partyInvites.length,1);
  const joinParty=await call('/api/party/respond',{method:'POST',cookie:friendCookie,body:{partyId:friendPartyInvites.data.partyInvites[0].id,accept:true}});assert.equal(joinParty.status,200);
  const shareReport=await call('/api/party/share',{method:'POST',cookie,body:{reportId:gaming.data.report.id}});assert.equal(shareReport.status,200);
  const friendParty=await call('/api/party',{cookie:friendCookie});assert.equal(friendParty.status,200);assert.equal(friendParty.data.party.reports.length,1);
  const deletedReport=await call(`/api/reports/${home.data.report.id}`,{method:'DELETE',cookie});assert.equal(deletedReport.status,200);
  const afterDelete=await call('/api/reports',{cookie});assert.equal(afterDelete.data.reports.length,2);
  const deletedAccount=await call('/api/account',{method:'DELETE',cookie});assert.equal(deletedAccount.status,200);
  const afterAccountDelete=await call('/api/me',{cookie});assert.equal(afterAccountDelete.status,200);assert.equal(afterAccountDelete.data.user,null);
});

test('under-13 accounts are blocked in the public MVP',async()=>{
  const response=await call('/api/signup',{method:'POST',body:{name:'Young Learner',email:'young@example.test',password:'password123',dob:dobForAge(11)}});
  assert.equal(response.status,403);assert.match(response.data.error,/13 and older/);
});

test('under-10 accounts are also blocked',async()=>{
  const response=await call('/api/signup',{method:'POST',body:{name:'Child',email:'child@example.test',password:'password123',dob:dobForAge(8)}});
  assert.equal(response.status,403);assert.match(response.data.error,/13 and older/);
});

test('responses include privacy and browser safety headers',async()=>{
  const response=await fetch(base+'/');assert.equal(response.status,200);assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
