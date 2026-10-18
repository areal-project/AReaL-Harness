window.maskInput = { mouse: 0, keys: 0 };
document.addEventListener("pointerdown", () => window.maskInput.mouse++);
document.addEventListener("keydown", () => window.maskInput.keys++);
