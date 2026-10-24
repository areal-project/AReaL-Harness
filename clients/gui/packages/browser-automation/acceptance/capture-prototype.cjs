const { app, BrowserWindow, WebContentsView, nativeImage } = require('electron');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const home = mkdtempSync(join(tmpdir(), 'areal-capture-prototype-'));
app.setPath('userData', home);
app.commandLine.appendSwitch('disable-gpu-sandbox');
setTimeout(() => { console.error('prototype deadline'); app.exit(1); }, 20000).unref();
console.log('prototype starting');
app.whenReady().then(async () => {
 console.log('prototype ready');
 const window = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
 const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
 window.contentView.addChildView(view); view.setBounds({ x:0,y:0,width:640,height:480 }); view.setVisible(false);
 const contents = view.webContents; await contents.loadURL('data:text/html,<body style="margin:0;background:rgb(30,180,80)"><h1>Hidden capture truth</h1><div style="height:1800px"></div>');
 console.log('prototype loaded'); contents.debugger.attach('1.3');
 const focus = BrowserWindow.getFocusedWindow();
 const bootstrap = require('../dist/index.cjs').startBrowserScreenshotTransparentWindowBootstrap({win:window,enabled:true,windowId:window.id,webContentsId:contents.id,requestId:'prototype'});
 view.setVisible(true);
 await new Promise(resolve => setTimeout(resolve, 200));
 const results = [];
 for (const fromSurface of [true]) {
  const image = await contents.debugger.sendCommand('Page.captureScreenshot', { format:'png',fromSurface,captureBeyondViewport:true });
  const native = nativeImage.createFromBuffer(Buffer.from(image.data,'base64')); const size=native.getSize();
  assert.ok(size.width > 0 && size.height > 0); assert.equal(BrowserWindow.getFocusedWindow(),focus); assert.equal(window.isFocused(),false); assert.equal(window.getOpacity(),0);
  const bitmap=native.toBitmap(); assert.ok(bitmap.some((byte,index)=>index%4!==3 && byte<240));
  const path=join(home,`hidden-${fromSurface}.png`); writeFileSync(path,native.toPNG()); results.push({fromSurface,size,path});
 }
 view.setVisible(false); bootstrap?.release();
 assert.equal(window.isVisible(),false);
 console.log(JSON.stringify({electron:process.versions.electron,focusUnchanged:true,results}));
 contents.close(); window.destroy(); app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
