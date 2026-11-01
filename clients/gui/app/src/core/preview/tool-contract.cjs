// @ts-check
"use strict";
/**
 * @typedef {'Enter'|'Tab'|'Escape'|'Backspace'|'ArrowUp'|'ArrowDown'|'ArrowLeft'|'ArrowRight'} ActionKey
 * @typedef {{kind:'clickAt',x:number,y:number}|{kind:'drag',fromX:number,fromY:number,toX:number,toY:number,steps:number}|{kind:'pressAt',x:number,y:number,key:ActionKey}} CoordinateAction
 * @typedef {{kind:'click'|'hover',ref:string}|{kind:'fill'|'selectOption',ref:string,value:string}|{kind:'setChecked',ref:string,checked:boolean}|{kind:'press',ref:string,key:ActionKey}|{kind:'scroll',target:'viewport',deltaX:number,deltaY:number}|CoordinateAction} BrowserAction
 * @typedef {{kind:'documentReady',state:'interactive'|'complete'}|{kind:'checked'|'enabled',ref:string,value:boolean}|{kind:'accessibleName',ref:string,name:string}} WaitCondition
 * @typedef {{timeoutMs:number,condition?:WaitCondition}} WaitParameters
 * @typedef {{operation:'act',snapshotId:string,action:BrowserAction}|({operation:'wait'} & WaitParameters)} BatchStep
 * @typedef {{operation:'describe',parameters:{topic?:string}}
 * | {operation:'command',parameters:{pageId:string,command:import('@areal/browser-automation').BrowserCommandInput}}
 * | {operation:'openDocument',parameters:{pageId:string,path:string}}
 * | {operation:'navigate'|'newPage',parameters:{pageId:string,url:string}}
 * | {operation:'diagnostics',parameters:{pageId:string,kind:'console'|'network',cursor?:number,limit?:number}}
 * | {operation:'observe',parameters:{pageId:string,scope?:'document',rootRef?:string,budget?:{nodes?:number,textBytes?:number}}}
 * | {operation:'capture',parameters:{pageId:string,scope:'viewport'}}
 * | {operation:'act',parameters:{pageId:string,snapshotId:string,action:BrowserAction}}
 * | {operation:'wait',parameters:{pageId:string} & WaitParameters}
 * | {operation:'runBatch',parameters:{pageId:string,snapshotId:string,steps:BatchStep[]}}} BrowserToolInput
 */
module.exports = {};
