export function toast(message:string) { document.dispatchEvent(new CustomEvent("areal:toast",{detail:message})); }
