// The Harbor page. Plain HTML and a small script, served by the Worker.

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harbor</title>
<style>
  :root { color-scheme: light; font-family: system-ui, sans-serif; }
  body { margin: 0; background: #f2f4f7; color: #111a27; }
  main { max-width: 640px; margin: 48px auto; padding: 0 16px; }
  h1 { font-size: 28px; margin: 0 0 16px; }
  label { margin-right: 8px; }
  ul { padding-left: 18px; }
  li { margin: 4px 0; }
  .status { color: #5a6578; }
</style>
</head>
<body>
<main>
  <h1>Your issues</h1>
  <p><label for="viewer">Viewer</label><select id="viewer"><option>demo-alice</option><option>demo-bob</option></select></p>
  <ul id="issues"></ul>
  <div id="actions"></div>
</main>
<script type="module">
  const viewer = document.getElementById("viewer");
  const list = document.getElementById("issues");
  async function load() {
    const res = await fetch("/api/issues", { headers: { "x-harbor-viewer": viewer.value } });
    const issues = await res.json();
    list.replaceChildren(...issues.map((i) => {
      const li = document.createElement("li");
      li.textContent = i.id + " " + i.title + " ";
      const s = document.createElement("span");
      s.className = "status";
      s.textContent = i.status;
      li.append(s);
      return li;
    }));
  }
  viewer.addEventListener("change", load);
  load();
</script>
</body>
</html>`;
