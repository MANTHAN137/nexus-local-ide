import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const digest = text => crypto.createHash('sha256').update(text).digest('hex');
export function protectedPath(relative) {
  return relative.split('/').some(p => ['.git','.ssh','.aws','.azure','.gnupg','.nexus-agent','.npmrc','.pypirc','.netrc'].includes(p) || (p.startsWith('.env') && !['.env.example','.env.sample'].includes(p)) || /\.(pem|key|p12|pfx)$/i.test(p));
}
export async function scopedPath(root, relative, {allowRoot=false, protect=false}={}) {
  if(typeof relative!=='string' || relative.length>1000 || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative) || /^[a-z]:/i.test(relative)) throw new Error('Use a relative path inside the selected project.');
  if(relative==='.' && allowRoot) return root;
  const parts=relative.split('/');
  if(parts.some(p=>!p || p==='.' || p==='..')) throw new Error('Parent traversal and empty path segments are not allowed.');
  if(protect && protectedPath(relative)) throw new Error('This path is protected from the agent.');
  let cursor=root;
  for(let i=0;i<parts.length;i++) {
    cursor=path.join(cursor,parts[i]);
    try {const s=await fs.lstat(cursor);if(s.isSymbolicLink())throw new Error('Symlinks are not allowed for this operation.');if(s.isFile()&&s.nlink>1)throw new Error('Hard-linked files are not allowed for this operation.');if(i<parts.length-1&&!s.isDirectory())throw new Error('A parent path is not a folder.');}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const rel=path.relative(root,cursor);if((rel==='..'||rel.startsWith('../'))||path.isAbsolute(rel))throw new Error('Path is outside the selected project.');
  return cursor;
}
export async function statScoped(root,relative) {
  const file=await scopedPath(root,relative),stat=await fs.lstat(file);
  if(stat.isDirectory())return {path:relative,directory:true};
  if(!stat.isFile())throw new Error('Only regular project files are supported.');
  const hash=crypto.createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return {path:relative,bytes:stat.size,version:hash.digest('hex')};
}
export async function readScoped(root,relative) {
  const file=await scopedPath(root,relative),s=await fs.stat(file);
  if(!s.isFile()||s.size>512*1024)throw new Error('Agent reads support text files up to 512 KB. Read a smaller source file.');
  const content=await fs.readFile(file,'utf8');if(content.includes('\0'))throw new Error('Binary files cannot be read by the coding agent.');
  return {path:relative,content,version:digest(content)};
}
export async function writeScoped(root,relative,content,expected,{protect=false}={}) {
  if(typeof content!=='string'||Buffer.byteLength(content)>512*1024)throw new Error('File content must be text up to 512 KB.');
  const file=await scopedPath(root,relative,{protect});
  let before=null,mode=0o644;
  try {const s=await fs.stat(file);if(!s.isFile())throw new Error('The target is not a file.');if(s.size>512*1024)throw new Error('Use a smaller file for text edits (512 KB maximum).');mode=s.mode;before=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(before===null ? expected!==null : !expected || digest(before)!==expected) throw new Error(before===null?'The file disappeared. Inspect the project again.':'File exists or changed: read it before editing to preserve existing work.');
  await fs.mkdir(path.dirname(file),{recursive:true});await scopedPath(root,relative,{protect});
  const tmp=path.join(path.dirname(file),`.nexus-write-${crypto.randomUUID()}`);
  try {await fs.writeFile(tmp,content,{flag:'wx',mode});
    if(before===null){await fs.link(tmp,file);}else{const now=await fs.readFile(file,'utf8');if(digest(now)!==expected)throw new Error('File changed during the write. Read it again.');await fs.rename(tmp,file);}
  }finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
  return {path:relative,version:digest(content),created:before===null,bytes:Buffer.byteLength(content),before};
}
export async function listScoped(root,relative='.') {
  const folder=await scopedPath(root,relative,{allowRoot:true});let count=0;
  const walk=async(dir,prefix,depth)=>{const out=[];for(const e of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(count>=500)break;const name=prefix?`${prefix}/${e.name}`:e.name;if(e.isSymbolicLink()||['node_modules','dist','.venv','__pycache__'].includes(e.name))continue;count++;out.push(name+(e.isDirectory()?'/':''));if(e.isDirectory()&&depth<3)out.push(...await walk(path.join(dir,e.name),name,depth+1));}return out;};
  return {files:await walk(folder,relative==='.'?'':relative,0),limited:count>=500};
}
export async function fileOperation(root,request) {
  if(request.tool==='list_files')return listScoped(root,request.path||'.');
  if(request.tool==='stat_path')return statScoped(root,request.path);
  if(request.tool==='read_file')return readScoped(root,request.path);
  if(request.tool==='write_file')return writeScoped(root,request.path,request.content,request.expected??null);
  if(request.tool==='append_file') {
    const original=await readScoped(root,request.path);
    if(original.version!==request.expected)throw new Error('Read the file before appending, and retry if it changed.');
    if(typeof request.content!=='string'||!request.content)throw new Error('Provide a nonempty content chunk.');
    return writeScoped(root,request.path,original.content+request.content,request.expected);
  }
  if(request.tool==='replace_in_file'){
    const original=await readScoped(root,request.path);if(original.version!==request.expected)throw new Error('Read the file before editing, and retry if it changed.');
    if(typeof request.old_text!=='string'||!request.old_text||typeof request.new_text!=='string')throw new Error('Provide nonempty old_text and replacement new_text.');
    if(original.content.split(request.old_text).length!==2)throw new Error('old_text must match exactly one location. Include more surrounding code.');
    return writeScoped(root,request.path,original.content.replace(request.old_text,()=>request.new_text),request.expected);
  }
  if(request.tool==='create_directory') {
    const target=await scopedPath(root,request.path);
    await fs.mkdir(target,{recursive:true});
    return {path:request.path,directory:true,operation:'created'};
  }
  if(['move_file','rename_file','delete_file'].includes(request.tool)) {
    const source=await scopedPath(root,request.path);
    const stat=await fs.lstat(source);
    if(stat.isDirectory()) {
      // Empty directories can be deleted; recursive deletion is deliberately explicit per file.
      if(request.tool==='delete_file') {await fs.rmdir(source);return {path:request.path,operation:'deleted',directory:true};}
      // Inspect the complete tree before moving it, including hidden entries.
      const inspect=async dir=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){
        const rel=path.relative(root,path.join(dir,entry.name));await scopedPath(root,rel);
        if(entry.isDirectory())await inspect(path.join(dir,entry.name));
      }};await inspect(source);
    } else {
      const original=await statScoped(root,request.path);
      if(!request.expected||original.version!==request.expected)throw new Error('Read the file before moving or deleting it; it may have changed.');
    }
    if(request.tool==='delete_file') {await fs.unlink(source);return {path:request.path,operation:'deleted'};}
    const target=await scopedPath(root,request.destination);
    if(target===source||target.startsWith(source+path.sep))throw new Error('Choose a different destination outside the source folder.');
    try {await fs.lstat(target);throw new Error('Destination already exists. Choose a new path.');}catch(e){if(e.code!=='ENOENT')throw e;}
    await fs.mkdir(path.dirname(target),{recursive:true});
    await scopedPath(root,request.destination);
    if(stat.isDirectory())await fs.rename(source,target);
    else {await fs.link(source,target);await fs.unlink(source);}
    return {path:request.path,destination:request.destination,operation:'moved',directory:stat.isDirectory()};
  }
  throw new Error('Unknown file tool.');
}

// Fixed broker code; requests arrive as data over stdin. Electron supplies its
// embedded Node runtime, so file tools do not depend on a system Node install.
if(process.env.NEXUS_AGENT_WORKER==='1') {
  let input='';
  try {
    for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>4*1024*1024)throw new Error('Request too large.');}
    const request=JSON.parse(input),root=await fs.realpath(process.cwd());
    process.stdout.write(JSON.stringify({ok:true,result:await fileOperation(root,request)}));
  }catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.message}));}
}
