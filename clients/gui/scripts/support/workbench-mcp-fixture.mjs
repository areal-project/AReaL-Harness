import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// 沿用 mcp-app-lifecycle-smoke 的插件目录与 stdio MCP 协议，只保留本场景需要的工具。
export async function createWorkbenchMcpFixture(workspace, evidence) {
  const plugin = join(workspace, "packages", "host-mcp");
  await mkdir(plugin, { recursive: true });
  await mkdir(join(workspace, ".agents", "plugins"), { recursive: true });
  await writeFile(
    join(plugin, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "host-mcp",
      version: "1.0.0",
      description: "Isolated Host MCP Apps fixture",
      extensions: { "com.openai": { interface: { displayName: "Host MCP Fixture" } } },
    }),
  );
  await writeFile(
    join(plugin, "app.html"),
    `<!doctype html><html><body><h1>Host MCP App</h1><p>Real MCP resource served through Host pages.</p><output id="ready">Waiting for host</output><p><button id="echo" disabled>Call MCP echo</button></p><output id="echo-result" aria-live="polite"></output><script>
let sequence=0;const pending=new Map();
const call=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});
addEventListener('message',event=>{if(event.source!==parent)return;const value=event.data;if(value.jsonrpc!=='2.0')return;const request=pending.get(value.id);if(request){pending.delete(value.id);value.error?request.reject(value.error):request.resolve(value.result);}});
const echoButton=document.querySelector('#echo'),echoResult=document.querySelector('#echo-result');
echoButton.addEventListener('click',async()=>{echoButton.disabled=true;echoResult.textContent='Calling MCP echo';try{const result=await call('tools/call',{name:'fixture.echo',arguments:{text:'HOST_MCP_UI_ECHO'}});echoResult.textContent=(result.content||[]).filter(item=>item.type==='text').map(item=>item.text).join('\\n');}catch(error){echoResult.textContent='Error: '+(error.message||String(error));}finally{echoButton.disabled=false;}});
call('ui/initialize',{appInfo:{name:'host-mcp',version:'1'},protocolVersion:'2026-01-26',appCapabilities:{}}).then(()=>{document.querySelector('#ready').textContent='MCP App initialized';parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');echoButton.disabled=false;}).catch(error=>{document.querySelector('#ready').textContent='Error: '+(error.message||String(error));});
</script></body></html>`,
  );
  await writeFile(
    join(plugin, "server.mjs"),
    String.raw`import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const tools=[{name:'fixture.page',title:'Host MCP App',description:'Open the isolated Host MCP App.',inputSchema:{type:'object',additionalProperties:false},annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:'ui://fixture/host',visibility:['model']},'openai/ui':{entrypoints:[{type:'global'},{type:'thread'}]}}},{name:'fixture.echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},annotations:{readOnlyHint:true},_meta:{ui:{visibility:['app']}}}];
for await(const line of createInterface({input:process.stdin})){let q;try{q=JSON.parse(line);appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(q)+'\n');if(q.id===undefined)continue;let result;switch(q.method){
case'initialize':result={protocolVersion:q.params.protocolVersion,serverInfo:{name:'host-mcp-fixture',version:'1'},capabilities:{tools:{},resources:{},extensions:{'io.modelcontextprotocol/ui':{}}}};break;
case'ping':result={};break;case'tools/list':result={tools};break;
case'resources/list':result={resources:[{uri:'ui://fixture/host',name:'Host MCP App',mimeType:'text/html;profile=mcp-app'}]};break;
case'resources/templates/list':result={resourceTemplates:[]};break;
case'resources/read':result={contents:[{uri:q.params.uri,mimeType:'text/html;profile=mcp-app',text:readFileSync(fileURLToPath(new URL('./app.html',import.meta.url)),'utf8'),_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}}}}]};break;
case'tools/call':result=q.params.name==='fixture.echo'?{content:[{type:'text',text:q.params.arguments.text}]}:{content:[{type:'text',text:'HOST_MCP_OPENED'}]};break;
default:throw Error('unsupported fixture method '+q.method);}send({jsonrpc:'2.0',id:q.id,result});}catch(error){if(q?.id!==undefined)send({jsonrpc:'2.0',id:q.id,error:{code:-32602,message:error.message}});}}
`,
  );
  await writeFile(
    join(plugin, "launch"),
    `#!/bin/sh
exec "${process.execPath}" "$PLUGIN_ROOT/server.mjs"
`,
  );
  await chmod(join(plugin, "launch"), 0o755);
  await writeFile(
    join(plugin, "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        fixture: {
          type: "stdio",
          command: "./launch",
          args: [],
          env: { FIXTURE_LOG: join(evidence, "mcp-transport.jsonl") },
        },
      },
    }),
  );
  await writeFile(
    join(workspace, ".agents/plugins/marketplace.json"),
    JSON.stringify({
      name: "host-mcp-market",
      plugins: [
        {
          name: "host-mcp",
          source: { source: "local", path: "./packages/host-mcp" },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
          category: "Productivity",
        },
      ],
    }),
  );
  return { id: "host-mcp@host-mcp-market", html: join(plugin, "app.html") };
}
