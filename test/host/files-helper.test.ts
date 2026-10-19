import {it, expect} from 'vitest';
import {mkdtemp, writeFile, readFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

it('pushes, skips, pins revisions, resumes and rejects corrupt downloads without leaking credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(),'files-client-'));
  const oldFetch = globalThis.fetch, oldToken = process.env.PIMWELL_TOKEN_FILE;
  try {
    const helper = join(dir,'helper.mjs');
    await writeFile(helper,await readFile('src/files-helper.txt'));
    const {main,safePath} = await import(/* @vite-ignore */ helper);
    for (const path of ['../a','/a','a//b','a\\b','x.pimwell-part']) expect(() => safePath(path)).toThrow();
    const tokenFile = join(dir,'token'); await writeFile(tokenFile,'pmw_synthetic-private'); process.env.PIMWELL_TOKEN_FILE=tokenFile;
    const source = join(dir,'source'), target = join(dir,'target'), manifest = join(dir,'manifest.json');
    await mkdir(source); await mkdir(target);
    const bytes = Buffer.from('hello world'), sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(source,'a.txt'),bytes);
    let published = false, puts = 0, interrupt = true, received = false, ranges = 0, corrupt = false;
    const file = {path:'a.txt',revision:1,sha256,size:bytes.length};
    globalThis.fetch = (async (url: URL, opts: RequestInit) => {
      expect(url.origin).toBe('https://org.pimwell.test'); expect(url.href).not.toContain('synthetic-private');
      expect(opts.headers).toMatchObject({authorization:url.pathname === '/api/session.start' ? 'Bearer pmw_synthetic-private' : 'Bearer synthetic-session'}); expect(opts.redirect).toBe('error');
      const input = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
      let result: any;
      if (url.pathname === '/api/session.start') result={session_token:'synthetic-session'};
      else if (url.pathname === '/api/file.list') result = {files:published ? [file] : [],next_cursor:null};
      else if (url.pathname === '/api/file.upload_url') result = {upload_url:'https://org.pimwell.test/upload?token=capability',parts:1,part_bytes:16*1024**2,expires_at:Date.now()+100000};
      else if (url.pathname === '/api/file.get') { if (input.revision) expect(input.revision).toBe(1); result = {file,download_url:'https://org.pimwell.test/download'}; }
      else if (url.pathname === '/upload') {
        if (opts.method === 'PUT') {puts++; received=true; if(interrupt) {interrupt=false; throw Error('interrupted');} result={sha256};}
        else if (opts.method === 'POST') {published=true;result=file;}
        else result={received:received ? [{part:1,sha256}] : []};
      } else if (url.pathname === '/download') {
        const range = (opts.headers as any).Range;
        if(range) {ranges++; expect(range).toBe('bytes=5-'); return new Response(bytes.subarray(5),{status:206,headers:{'content-range':'bytes 5-10/11'}});}
        return new Response(corrupt ? Buffer.from('wrong bytes') : bytes);
      } else throw Error('Unexpected request');
      return Response.json({ok:true,result});
    }) as any;
    const args = ['push','https://org.pimwell.test','project',source,manifest];
    await expect(main(args)).rejects.toThrow('interrupted');
    await main(args); expect(puts).toBe(1);
    await main(args); expect(puts).toBe(1);
    await writeFile(join(target,'a.txt.pimwell-part'),bytes.subarray(0,5));
    await main(['pull',args[1],'project',target,manifest]); expect(ranges).toBe(1);
    expect(await readFile(join(target,'a.txt'))).toEqual(bytes);
    await main(['pull',args[1],'project',target,manifest]); expect(ranges).toBe(1);
    await rm(join(target,'a.txt')); corrupt=true;
    await expect(main(['pull',args[1],'project',target,manifest])).rejects.toThrow('checksum');
    await expect(readFile(join(target,'a.txt'))).rejects.toThrow();
  } finally {
    globalThis.fetch=oldFetch;
    if(oldToken===undefined) delete process.env.PIMWELL_TOKEN_FILE; else process.env.PIMWELL_TOKEN_FILE=oldToken;
    await rm(dir,{recursive:true,force:true});
  }
});
