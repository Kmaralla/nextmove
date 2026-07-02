const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const path=require('node:path');
const os=require('node:os');

process.env.OPENAI_API_KEY='test-key';
process.env.NEXTMOVE_DB_FILE=path.join(os.tmpdir(),`nextmove-test-${process.pid}.json`);
const {createServer,validateAnalyzePayload}=require('../server');

const image='data:image/jpeg;base64,aGVsbG8=';
const pdf='data:application/pdf;base64,aGVsbG8=';
const frames=()=>[0,1,2].map(i=>({time:`0:0${i}`,data:image}));
const dobForAge=age=>`${new Date().getFullYear()-age}-01-15`;
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
  const signup=await call('/api/signup',{method:'POST',body:{name:'Test Learner',email:'adult@example.test',password:'password123',dob:dobForAge(18)}});
  assert.equal(signup.status,201);const cookie=signup.cookie.split(';')[0];
  const home=await call('/api/analyze',{method:'POST',cookie,body:{mode:'homework',meta:{subject:'Math',level:'College',coach:'Maya'},file:{name:'work.pdf',kind:'pdf',data:pdf}}});
  assert.equal(home.status,200);assert.equal(home.data.report.mode,'homework');
  const gaming=await call('/api/analyze',{method:'POST',cookie,body:{mode:'gaming',meta:{game:'Rocket League',role:'Ranked',coach:'Byte'},frames:frames()}});
  assert.equal(gaming.status,200);assert.equal(gaming.data.report.mode,'gaming');
  const sports=await call('/api/analyze',{method:'POST',cookie,body:{mode:'sports',meta:{sport:'Soccer',position:'Forward',coach:'Kai'},frames:frames(),faceReference:image}});
  assert.equal(sports.status,200);assert.equal(sports.data.report.mode,'sports');
  const reports=await call('/api/reports',{cookie});assert.equal(reports.status,200);assert.equal(reports.data.reports.length,3);
});

test('under-13 accounts require parent email and explicit approval',async()=>{
  const missing=await call('/api/signup',{method:'POST',body:{name:'Young Learner',email:'young-missing@example.test',password:'password123',dob:dobForAge(11)}});
  assert.equal(missing.status,400);assert.match(missing.data.error,/parent or guardian email/);
  const signup=await call('/api/signup',{method:'POST',body:{name:'Young Learner',email:'young@example.test',password:'password123',dob:dobForAge(11),parentEmail:'parent@example.test'}});
  assert.equal(signup.status,201);assert.equal(signup.data.user.consentStatus,'pending');const cookie=signup.cookie.split(';')[0];
  const blocked=await call('/api/analyze',{method:'POST',cookie,body:{mode:'homework',meta:{},file:{name:'work.jpg',kind:'image',data:image}}});assert.equal(blocked.status,403);
  const token=new URL(signup.data.consentPreviewUrl).searchParams.get('token');
  const getApproval=await call(`/api/consent?token=${token}`);assert.equal(getApproval.status,401);
  const approved=await call('/api/consent',{method:'POST',body:{token}});assert.equal(approved.status,200);
  const analyzed=await call('/api/analyze',{method:'POST',cookie,body:{mode:'homework',meta:{subject:'Science'},file:{name:'work.jpg',kind:'image',data:image}}});assert.equal(analyzed.status,200);
});

test('under-10 account must be parent-managed',async()=>{
  const response=await call('/api/signup',{method:'POST',body:{name:'Child',email:'child@example.test',password:'password123',dob:dobForAge(8),parentEmail:'parent2@example.test',isParent:false}});
  assert.equal(response.status,400);assert.match(response.data.error,/parent or guardian must create/);
});

test('responses include privacy and browser safety headers',async()=>{
  const response=await fetch(base+'/');assert.equal(response.status,200);assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
