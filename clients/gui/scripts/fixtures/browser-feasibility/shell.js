document.getElementById("takeover").addEventListener("click", async () => {
  await window.feasibility.takeover();
});
document.getElementById("unfreeze").addEventListener("click", async () => {
  await window.feasibility.unfreeze();
});
