// Fetches a feed and puts new items under "## Reading" in a daily note.
// Items already shown are remembered in seen.json, so they are not shown twice.
//   node scripts/fetch_feed.js 2026-10-02
const fs = require('fs');
const path = require('path');

const day = process.argv[2] || new Date().toISOString().slice(0, 10);
const note = path.join(__dirname, '..', 'notes', 'daily', `${day}.md`);
const seenFile = path.join(__dirname, 'seen.json');

async function items() {
  try {
    const res = await fetch('https://example.com/garden/feed.xml');
    const xml = await res.text();
    return [...xml.matchAll(/<title>(.*?)<\/title>/g)].map(m => m[1]);
  } catch (e) {
    console.error(`feed not reachable: ${e.message}`);
    return [];
  }
}

(async () => {
  const seen = new Set(JSON.parse(fs.readFileSync(seenFile, 'utf8')));
  const fresh = (await items()).filter(t => !seen.has(t));
  for (const t of fresh) seen.add(t);
  fs.writeFileSync(seenFile, JSON.stringify([...seen], null, 2) + '\n');
  const text = fs.readFileSync(note, 'utf8');
  const list = fresh.length ? fresh.map(t => `- ${t}`).join('\n') : '- (no new items)';
  fs.writeFileSync(note, text.replace(/## Reading\n[\s\S]*?(?=\n## |$)/, `## Reading\n${list}\n`));
})();
