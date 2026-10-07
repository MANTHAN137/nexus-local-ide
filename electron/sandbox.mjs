import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {protectedPath} from './scoped-files.mjs';

const quote=s=>JSON.stringify(s);
const binaries=['node','npm','python3'];
export async function discoverTools() {
  const tools={};
  const dirs=[...(process.env.PATH||'').split(path.delimiter),path.join(os.homedir(),'.local/bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin'];
  for(const name of binaries)for(const dir of dirs){if(tools[name])break;try{const file=await fs.realpath(path.join(dir,name));await fs.access(file,1);tools[name]=file;}catch{}}
  return tools;
}
export function sandboxProfile(root,scratch,toolPaths=[]) {
  const runtimeRoots=[...new Set(toolPaths.map(p=>p.includes('/bin/')?p.slice(0,p.lastIndexOf('/bin/')):path.dirname(p)))];
  const reads=['/System/Library','/System/Cryptexes','/System/Volumes/Preboot','/private/preboot','/private/var/db/dyld','/usr','/bin','/sbin','/Library/Apple','/Library/Developer','/opt/homebrew/Cellar','/opt/homebrew/opt','/opt/homebrew/lib',...runtimeRoots,root,scratch];
  return `(version 1)
(deny default)
(allow process-fork process-exec)
(allow signal (target self))
(allow process-info* (target self))
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.logger"))
(allow file-read-metadata)
(allow file-read* ${reads.map(p=>`(subpath ${quote(p)})`).join(' ')})
(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/private/etc/localtime"))
(allow file-write* (subpath ${quote(root)}) (subpath ${quote(scratch)}) (literal "/dev/null"))
(deny process-exec (literal "/usr/bin/sudo") (literal "/usr/bin/osascript") (literal "/usr/bin/open") (literal "/bin/launchctl") (literal "/usr/bin/security"))
`;
}
export class SandboxRunner {
  constructor(root,tools){this.root=root;this.tools=tools;this.children=new Set();this.cancelled=false;}
  static async create(root){
    if(process.platform!=='darwin')throw new Error('Agent execution requires the macOS sandbox in this release. No unrestricted fallback is available.');
    await fs.access('/usr/bin/sandbox-exec',1);
    const actual=await fs.realpath(root);const broad=['/',os.homedir(),'/Users','/System','/Library','/Applications',path.join(os.homedir(),'Desktop'),path.join(os.homedir(),'Documents')];
    if(broad.includes(actual)||protectedPath(actual)||['/System','/Library','/Applications','/usr','/bin','/sbin','/private/etc','/etc','/opt',path.join(os.homedir(),'Library')].some(p=>actual===p||actual.startsWith(p+'/')))throw new Error('Choose a specific project folder, not a home, desktop, or system directory.');
    const tools=await discoverTools();
    return new SandboxRunner(actual,tools);
  }
  cancel(){this.cancelled=true;for(const child of this.children){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}}
  async execute(binary,args,{input='',timeout=120000,worker=false}={}){
    if(this.cancelled)throw new Error('Agent stopped.');
    const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-agent-'));
    const actualScratch=await fs.realpath(scratch);
    const env={PATH:[path.dirname(this.tools.node || binary),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'].join(':'),HOME:actualScratch,TMPDIR:actualScratch,TMP:actualScratch,TEMP:actualScratch,LANG:'en_US.UTF-8',CI:'1',NO_COLOR:'1',PYTHONDONTWRITEBYTECODE:'1',npm_config_cache:path.join(actualScratch,'npm-cache'),npm_config_userconfig:path.join(actualScratch,'npmrc'),npm_config_offline:'true',npm_config_audit:'false',npm_config_fund:'false',...(worker?{NEXUS_AGENT_WORKER:'1',ELECTRON_RUN_AS_NODE:'1'}:{})};
    const profile=sandboxProfile(this.root,actualScratch,[...Object.values(this.tools),binary,...(worker&&process.versions.electron?[path.join(path.dirname(process.execPath),'..','broker-runtime')]:[])]);
    try{return await new Promise((resolve,reject)=>{
      let stdout='',stderr='',timedOut=false;
      const child=spawn('/usr/bin/sandbox-exec',['-p',profile,binary,...args],{cwd:this.root,env,stdio:['pipe','pipe','pipe'],detached:true,windowsHide:true});this.children.add(child);
      const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
      const timer=setTimeout(()=>{timedOut=true;kill();},timeout);
      const limit=worker?4*1024*1024:24000;
      child.stdout.on('data',chunk=>{stdout=(stdout+chunk).slice(-limit);});child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-limit);});
      child.on('error',e=>{clearTimeout(timer);this.children.delete(child);reject(e);});
      child.on('close',(code,signal)=>{clearTimeout(timer);this.children.delete(child);kill();resolve({stdout,stderr,code,signal,timedOut,cancelled:this.cancelled});});
      child.stdin.on('error',()=>{});child.stdin.end(input);
    });}finally{await fs.rm(actualScratch,{recursive:true,force:true});}
  }
  async preflight(){if(!this.tools.node)throw new Error('Install Node.js to run project checks. File tools work without it.');const result=await this.execute(this.tools.node,['-e','process.stdout.write("nexus-sandbox-ok")'],{timeout:10000});if(result.code!==0||result.stdout!=='nexus-sandbox-ok')throw new Error(`The OS sandbox could not start. Agent access is disabled. ${result.signal || result.code}: ${result.stderr.slice(-500)}`);}
  async file(request){
    if(this.cancelled)throw new Error('Agent stopped.');
    if(await fs.realpath(this.root)!==this.root)throw new Error('Project location changed. Open the folder again.');
    const source=await fs.readFile(fileURLToPath(new URL('./scoped-files.mjs',import.meta.url)),'utf8');
    const result=await this.execute(process.execPath,['--input-type=module','-e',source],{input:JSON.stringify(request),worker:true,timeout:60000});
    if(result.code!==0)throw new Error(`Project file operation failed (${result.timedOut?'timed out':result.signal||result.code}): ${result.stderr.slice(-1000)}`);
    let response;try{response=JSON.parse(result.stdout);}catch{throw new Error('Project file broker returned an invalid response.');}
    if(!response.ok)throw new Error(response.error);
    return response.result;
  }
  async check(command){
    if(!Array.isArray(command)||command.length<1||command.length>30||command.some(x=>typeof x!=='string'||x.length>1000||/[\0\n\r]/.test(x)))throw new Error('Provide command as a short array of arguments.');
    const [name,...args]=command;
    if(!binaries.includes(name)||!this.tools[name])throw new Error('Checks support installed node, npm and python3 only.');
    if(name==='npm' && !(args.length===1&&args[0]==='test') && !(args.length===2&&args[0]==='run'&&['test','build','lint','check','typecheck'].includes(args[1])))throw new Error('Allowed npm checks: npm test, npm run test/build/lint/check/typecheck. Package installation and network access are disabled.');
    if(name==='node' && !args.length)throw new Error('Specify a project test script or --test.');
    if(name==='node' && args.some(a=>['-e','--eval','-p','--print','-r','--require','--import','--loader','--experimental-loader'].some(flag=>a===flag||a.startsWith(flag+'='))))throw new Error('Run a project script or node --test; inline evaluation and injected loaders are disabled.');
    if(name==='python3' && !(args[0]==='-m'&&['unittest','pytest','compileall'].includes(args[1])) && !(/^[^\-].*\.py$/.test(args[0]||'')))throw new Error('Use a project Python script, unittest, pytest or compileall.');
    for(const arg of args){if(path.isAbsolute(arg)||arg.split('/').includes('..')||arg.includes('\\'))throw new Error('Check arguments must stay inside the selected project.');}
    if(!this.tools.node && name==='npm')throw new Error('Install Node.js to run npm checks.');
    const executable=name==='npm'?this.tools.node:this.tools[name];const actualArgs=name==='npm'?[this.tools.npm,...args]:args;
    const result=await this.execute(executable,actualArgs);return {...result,command:command.join(' '),sandboxed:true};
  }
}
