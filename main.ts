import { Hono } from "https://deno.land/x/hono@v4.3.6/mod.ts";
import { cors } from "https://deno.land/x/hono@v4.3.6/middleware/cors/index.ts";
import Anthropic from "npm:@anthropic-ai/sdk";
import { extractText } from "npm:unpdf@0.12.1";

const app = new Hono();
const kv = await Deno.openKv();

app.use("/*", cors());

// --- Seed classes on first run ---
const CLASSES = [
  { id: "1", name: "AP Calculus BC", short_name: "Calc BC", color: "#6366f1" },
  { id: "2", name: "AP Chemistry", short_name: "AP Chem", color: "#ec4899" },
  { id: "3", name: "AP Government", short_name: "AP Gov", color: "#f59e0b" },
  { id: "4", name: "UW Composition 240", short_name: "UW Comp 240", color: "#10b981" },
  { id: "5", name: "Commercial Art and Design", short_name: "Comm Art", color: "#8b5cf6" },
  { id: "6", name: "ASB / Leadership", short_name: "ASB", color: "#ef4444" },
];

for (const cls of CLASSES) {
  await kv.set(["classes", cls.id], cls);
}

// --- KV helpers ---
async function kvList<T>(prefix: string[]): Promise<T[]> {
  const items: T[] = [];
  for await (const entry of kv.list<T>({ prefix })) {
    items.push(entry.value);
  }
  return items;
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// --- API: Classes ---
app.get("/api/classes", async (c) => {
  const classes = await kvList(["classes"]);
  return c.json(classes);
});

app.get("/api/classes/:id", async (c) => {
  const cls = await kv.get(["classes", c.req.param("id")]);
  if (!cls.value) return c.json({ error: "Not found" }, 404);
  return c.json(cls.value);
});

// --- API: Materials ---
app.get("/api/classes/:id/materials", async (c) => {
  const materials = await kvList(["materials", c.req.param("id")]);
  materials.sort((a: any, b: any) => (b.created_at || "").localeCompare(a.created_at || ""));
  return c.json(materials);
});

app.post("/api/classes/:id/materials", async (c) => {
  const classId = c.req.param("id");
  const body = await c.req.parseBody();

  const file = body["file"] as File | undefined;
  const title = (body["title"] as string) || "Untitled";
  let content = (body["content"] as string) || "";
  let fileName = null;

  if (file && file.size > 0) {
    fileName = file.name;
    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    if (file.name.toLowerCase().endsWith('.pdf')) {
      const result = await extractText(uint8);
      content = String(result.text || "");
    } else {
      content = await file.text();
    }
  }

  if (!String(content || "").trim()) {
    return c.json({ error: "No content provided" }, 400);
  }

  const id = genId();
  const material = { id, class_id: classId, title, content, file_name: fileName, created_at: new Date().toISOString() };
  await kv.set(["materials", classId, id], material);

  return c.json({ id, title, file_name: fileName }, 201);
});

app.delete("/api/materials/:classId/:id", async (c) => {
  await kv.delete(["materials", c.req.param("classId"), c.req.param("id")]);
  return c.json({ ok: true });
});

// --- API: Generate (Claude) ---
function getClient(): Anthropic {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  return new Anthropic({ apiKey });
}

async function getMaterials(classId: string, materialIds?: string[]) {
  const all = await kvList<{ id: string; title: string; content: string }>(["materials", classId]);
  if (materialIds && materialIds.length > 0) {
    return all.filter(m => materialIds.includes(m.id));
  }
  return all;
}

app.post("/api/classes/:id/generate/mcq", async (c) => {
  const classId = c.req.param("id");
  const { count = 5, materialIds } = await c.req.json();

  const cls = (await kv.get(["classes", classId])).value as { name: string };
  const materials = await getMaterials(classId, materialIds);

  if (materials.length === 0) {
    return c.json({ error: "No materials uploaded for this class yet" }, 400);
  }

  const client = getClient();
  const materialText = materials.map(m => `--- ${m.title} ---\n${m.content}`).join("\n\n");

  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: `You are a study assistant for a high school student in ${cls.name}. Based on the following study materials, generate ${count} multiple choice questions.

MATERIALS:
${materialText}

Return ONLY a JSON array with this exact format (no markdown, no code fences):
[
  {
    "question": "Question text here?",
    "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
    "answer": "A",
    "explanation": "Brief explanation of why this is correct"
  }
]`
    }]
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text : "";
  let questions;
  try {
    questions = JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    questions = match ? JSON.parse(match[0]) : [];
  }

  // Save to KV
  const ids: string[] = [];
  for (const q of questions) {
    const id = genId();
    ids.push(id);
    await kv.set(["questions", classId, id], {
      id, class_id: classId, type: "mcq",
      question: q.question, options: q.options, answer: q.answer,
      explanation: q.explanation || "", created_at: new Date().toISOString(),
    });
  }

  return c.json({ questions, ids });
});

app.post("/api/classes/:id/generate/frq", async (c) => {
  const classId = c.req.param("id");
  const { count = 3, materialIds } = await c.req.json();

  const cls = (await kv.get(["classes", classId])).value as { name: string };
  const materials = await getMaterials(classId, materialIds);

  if (materials.length === 0) {
    return c.json({ error: "No materials uploaded for this class yet" }, 400);
  }

  const client = getClient();
  const materialText = materials.map(m => `--- ${m.title} ---\n${m.content}`).join("\n\n");

  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: `You are a study assistant for a high school student in ${cls.name}. Based on the following study materials, generate ${count} free response questions that would appear on an AP exam or college-level assessment.

MATERIALS:
${materialText}

Return ONLY a JSON array with this exact format (no markdown, no code fences):
[
  {
    "question": "Full FRQ prompt with any necessary context or stimulus",
    "answer": "A thorough model answer that would receive full marks",
    "explanation": "Key points the grader would look for"
  }
]`
    }]
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text : "";
  let questions;
  try {
    questions = JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    questions = match ? JSON.parse(match[0]) : [];
  }

  const ids: string[] = [];
  for (const q of questions) {
    const id = genId();
    ids.push(id);
    await kv.set(["questions", classId, id], {
      id, class_id: classId, type: "frq",
      question: q.question, options: null, answer: q.answer,
      explanation: q.explanation || "", created_at: new Date().toISOString(),
    });
  }

  return c.json({ questions, ids });
});

app.post("/api/classes/:id/generate/study-guide", async (c) => {
  const classId = c.req.param("id");
  const { materialIds, topic } = await c.req.json();

  const cls = (await kv.get(["classes", classId])).value as { name: string };
  const materials = await getMaterials(classId, materialIds);

  if (materials.length === 0) {
    return c.json({ error: "No materials uploaded for this class yet" }, 400);
  }

  const client = getClient();
  const materialText = materials.map(m => `--- ${m.title} ---\n${m.content}`).join("\n\n");
  const topicLine = topic ? `Focus on the topic: ${topic}` : "Cover the key concepts from the materials.";

  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    messages: [{
      role: "user",
      content: `You are a study assistant for a high school student in ${cls.name}. Create a comprehensive study guide based on the following materials. ${topicLine}

MATERIALS:
${materialText}

Format the study guide in clean markdown with:
- A clear title
- Key concepts and definitions
- Important formulas/facts (if applicable)
- Common misconceptions
- Practice tips
- Summary

Make it easy to scan and review.`
    }]
  });

  const content = msg.content[0].type === "text" ? msg.content[0].text : "";
  const title = topic || `Study Guide - ${new Date().toLocaleDateString()}`;
  const id = genId();

  await kv.set(["study_guides", classId, id], {
    id, class_id: classId, title, content, created_at: new Date().toISOString(),
  });

  return c.json({ id, title, content });
});

// Grade FRQ answer
app.post("/api/grade-frq", async (c) => {
  const { question, modelAnswer, studentAnswer, className } = await c.req.json();

  const client = getClient();
  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [{
      role: "user",
      content: `You are grading a free response answer for ${className}.

QUESTION: ${question}

MODEL ANSWER: ${modelAnswer}

STUDENT ANSWER: ${studentAnswer}

Grade the student's answer. Return ONLY JSON (no markdown, no code fences):
{
  "score": <number 0-10>,
  "feedback": "Specific feedback on what was good and what was missed",
  "suggestions": "What the student should review or improve"
}`
    }]
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text : "";
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    result = match ? JSON.parse(match[0]) : { score: 0, feedback: "Could not parse response", suggestions: "" };
  }
  return c.json(result);
});

// --- API: Saved questions & guides ---
app.get("/api/classes/:id/questions", async (c) => {
  const questions = await kvList(["questions", c.req.param("id")]);
  const type = c.req.query("type");
  const filtered = type ? questions.filter((q: any) => q.type === type) : questions;
  filtered.sort((a: any, b: any) => (b.created_at || "").localeCompare(a.created_at || ""));
  return c.json(filtered);
});

app.get("/api/classes/:id/study-guides", async (c) => {
  const guides = await kvList(["study_guides", c.req.param("id")]);
  guides.sort((a: any, b: any) => (b.created_at || "").localeCompare(a.created_at || ""));
  return c.json(guides);
});

app.delete("/api/questions/:classId/:id", async (c) => {
  await kv.delete(["questions", c.req.param("classId"), c.req.param("id")]);
  return c.json({ ok: true });
});

app.delete("/api/study-guides/:classId/:id", async (c) => {
  await kv.delete(["study_guides", c.req.param("classId"), c.req.param("id")]);
  return c.json({ ok: true });
});

// --- Serve HTML ---
app.get("*", (c) => {
  return c.html(HTML);
});

const port = parseInt(Deno.env.get("PORT") || "3000");
console.log(`Study app running at http://localhost:${port}`);
Deno.serve({ port }, app.fetch);

// --- Inline HTML ---
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StudyLab</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0f0f13; --surface: #1a1a24; --surface2: #242436; --border: #2d2d44;
      --text: #e4e4ed; --text2: #9494a8; --accent: #6366f1; --accent2: #818cf8;
      --green: #10b981; --red: #ef4444; --yellow: #f59e0b; --radius: 12px;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
    .app { display: flex; min-height: 100vh; }
    .sidebar { width: 260px; background: var(--surface); border-right: 1px solid var(--border); padding: 24px 16px; display: flex; flex-direction: column; position: fixed; top: 0; left: 0; bottom: 0; overflow-y: auto; }
    .sidebar h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; background: linear-gradient(135deg, var(--accent), #a78bfa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .sidebar .subtitle { color: var(--text2); font-size: 13px; margin-bottom: 28px; }
    .class-list { list-style: none; flex: 1; }
    .class-item { padding: 10px 14px; border-radius: 8px; cursor: pointer; margin-bottom: 4px; display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 500; transition: background 0.15s; }
    .class-item:hover, .class-item.active { background: var(--surface2); }
    .class-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .main { margin-left: 260px; flex: 1; padding: 32px 40px; max-width: 960px; }
    .tabs { display: flex; gap: 4px; background: var(--surface); border-radius: 10px; padding: 4px; margin-bottom: 28px; }
    .tab { padding: 8px 18px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; color: var(--text2); border: none; background: none; transition: all 0.15s; }
    .tab:hover { color: var(--text); }
    .tab.active { background: var(--accent); color: white; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; margin-bottom: 20px; }
    .card h2 { font-size: 18px; margin-bottom: 16px; }
    .card h3 { font-size: 15px; color: var(--text2); margin-bottom: 12px; font-weight: 500; }
    .btn { padding: 10px 20px; border-radius: 8px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s; display: inline-flex; align-items: center; gap: 8px; }
    .btn-primary { background: var(--accent); color: white; }
    .btn-primary:hover { background: var(--accent2); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-secondary { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { border-color: var(--accent); }
    .btn-danger { background: transparent; color: var(--red); border: 1px solid var(--red); padding: 6px 12px; font-size: 12px; }
    .btn-danger:hover { background: var(--red); color: white; }
    .btn-sm { padding: 6px 14px; font-size: 13px; }
    input, textarea, select { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; color: var(--text); font-size: 14px; width: 100%; font-family: inherit; }
    input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); }
    textarea { resize: vertical; min-height: 100px; }
    label { display: block; font-size: 13px; color: var(--text2); margin-bottom: 6px; font-weight: 500; }
    .form-group { margin-bottom: 16px; }
    .material-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: var(--surface2); border-radius: 8px; margin-bottom: 8px; }
    .material-item .name { font-weight: 500; font-size: 14px; }
    .material-item .meta { font-size: 12px; color: var(--text2); }
    .question-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; margin-bottom: 16px; }
    .question-num { font-size: 12px; color: var(--accent2); font-weight: 600; text-transform: uppercase; margin-bottom: 8px; }
    .question-text { font-size: 16px; line-height: 1.6; margin-bottom: 16px; }
    .option { display: block; padding: 12px 16px; background: var(--surface2); border: 2px solid var(--border); border-radius: 8px; margin-bottom: 8px; cursor: pointer; font-size: 14px; transition: all 0.15s; }
    .option:hover { border-color: var(--accent); }
    .option.selected { border-color: var(--accent); background: rgba(99, 102, 241, 0.1); }
    .option.correct { border-color: var(--green); background: rgba(16, 185, 129, 0.1); }
    .option.incorrect { border-color: var(--red); background: rgba(239, 68, 68, 0.1); }
    .explanation { margin-top: 12px; padding: 12px 16px; background: rgba(99, 102, 241, 0.08); border-left: 3px solid var(--accent); border-radius: 0 8px 8px 0; font-size: 14px; line-height: 1.5; }
    .frq-answer-area { margin-top: 12px; }
    .frq-answer-area textarea { min-height: 120px; }
    .grade-result { margin-top: 12px; padding: 16px; background: var(--surface2); border-radius: 8px; }
    .grade-result .score { font-size: 24px; font-weight: 700; color: var(--accent); }
    .grade-result .feedback { margin-top: 8px; font-size: 14px; line-height: 1.5; }
    .study-guide-content { line-height: 1.7; font-size: 15px; }
    .study-guide-content h1 { font-size: 22px; margin: 20px 0 12px; }
    .study-guide-content h2 { font-size: 18px; margin: 18px 0 10px; color: var(--accent2); }
    .study-guide-content h3 { font-size: 16px; margin: 14px 0 8px; }
    .study-guide-content ul, .study-guide-content ol { padding-left: 24px; margin: 8px 0; }
    .study-guide-content li { margin-bottom: 4px; }
    .study-guide-content p { margin-bottom: 10px; }
    .study-guide-content strong { color: var(--accent2); }
    .study-guide-content code { background: var(--surface2); padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    .score-banner { background: linear-gradient(135deg, var(--accent), #a78bfa); border-radius: var(--radius); padding: 24px; text-align: center; margin-bottom: 20px; }
    .score-banner .score-big { font-size: 48px; font-weight: 700; }
    .score-banner .score-label { font-size: 14px; opacity: 0.8; margin-top: 4px; }
    .loading { display: inline-flex; align-items: center; gap: 8px; color: var(--text2); font-size: 14px; }
    .spinner { width: 18px; height: 18px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .badge-mcq { background: rgba(99, 102, 241, 0.15); color: var(--accent2); }
    .badge-frq { background: rgba(245, 158, 11, 0.15); color: var(--yellow); }
    .gen-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; }
    .gen-row .form-group { margin-bottom: 0; flex: 1; min-width: 120px; }
    .empty { text-align: center; padding: 48px 24px; color: var(--text2); }
    .empty .big { font-size: 48px; margin-bottom: 12px; opacity: 0.4; }
    .empty p { font-size: 14px; }
    .saved-item { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; background: var(--surface2); border-radius: 8px; margin-bottom: 8px; cursor: pointer; transition: border 0.15s; border: 1px solid transparent; }
    .saved-item:hover { border-color: var(--accent); }
    .saved-item .info { flex: 1; }
    .saved-item .title { font-weight: 500; font-size: 14px; }
    .saved-item .date { font-size: 12px; color: var(--text2); margin-top: 2px; }
    .material-check { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: var(--surface2); border-radius: 8px; margin-bottom: 6px; cursor: pointer; }
    .material-check:hover { background: var(--border); }
    .material-check input[type="checkbox"] { width: auto; accent-color: var(--accent); }
    @media (max-width: 768px) {
      .sidebar { width: 100%; position: relative; border-right: none; border-bottom: 1px solid var(--border); }
      .main { margin-left: 0; padding: 20px; }
      .app { flex-direction: column; }
      .class-list { display: flex; flex-wrap: wrap; gap: 4px; }
    }
  </style>
</head>
<body>
  <div class="app" id="app"></div>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script>
    const API = '';
    let state = {
      classes: [], currentClass: null, currentTab: 'materials',
      materials: [], questions: [], studyGuides: [],
      quizQuestions: null, quizType: null, quizAnswers: {}, quizSubmitted: false, quizGrades: {},
      viewingGuide: null, loading: false, loadingMsg: '',
    };

    async function api(path, opts = {}) {
      const res = await fetch(API + path, opts);
      return res.json();
    }

    async function loadClasses() {
      state.classes = await api('/api/classes');
      if (!state.currentClass && state.classes.length) state.currentClass = state.classes[0];
      render();
    }

    async function loadClassData() {
      if (!state.currentClass) return;
      const id = state.currentClass.id;
      const [materials, questions, guides] = await Promise.all([
        api('/api/classes/' + id + '/materials'),
        api('/api/classes/' + id + '/questions'),
        api('/api/classes/' + id + '/study-guides'),
      ]);
      state.materials = materials;
      state.questions = questions;
      state.studyGuides = guides;
      render();
    }

    function selectClass(cls) {
      state.currentClass = cls; state.currentTab = 'materials';
      state.quizQuestions = null; state.viewingGuide = null;
      loadClassData();
    }

    function selectTab(tab) {
      state.currentTab = tab; state.quizQuestions = null; state.viewingGuide = null; render();
    }

    async function uploadMaterial() {
      const title = document.getElementById('mat-title').value.trim();
      const content = document.getElementById('mat-content').value.trim();
      const fileInput = document.getElementById('mat-file');
      const file = fileInput?.files?.[0];
      if (!title && !file && !content) { alert('Please provide a title and content or a file'); return; }
      const form = new FormData();
      form.append('title', title || (file ? file.name : 'Untitled'));
      if (content) form.append('content', content);
      if (file) form.append('file', file);
      state.loading = true; state.loadingMsg = 'Uploading...'; render();
      await api('/api/classes/' + state.currentClass.id + '/materials', { method: 'POST', body: form });
      state.loading = false;
      await loadClassData();
    }

    async function deleteMaterial(id) {
      await api('/api/materials/' + state.currentClass.id + '/' + id, { method: 'DELETE' });
      loadClassData();
    }

    async function generateMCQ() {
      const count = parseInt(document.getElementById('mcq-count')?.value || '5');
      const materialIds = getSelectedMaterials();
      state.loading = true; state.loadingMsg = 'Generating MCQ questions...'; render();
      const data = await api('/api/classes/' + state.currentClass.id + '/generate/mcq', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count, materialIds: materialIds.length ? materialIds : undefined }),
      });
      state.loading = false;
      if (data.error) { alert(data.error); render(); return; }
      state.quizQuestions = data.questions; state.quizType = 'mcq';
      state.quizAnswers = {}; state.quizSubmitted = false;
      await loadClassData();
    }

    async function generateFRQ() {
      const count = parseInt(document.getElementById('frq-count')?.value || '3');
      const materialIds = getSelectedMaterials();
      state.loading = true; state.loadingMsg = 'Generating FRQ questions...'; render();
      const data = await api('/api/classes/' + state.currentClass.id + '/generate/frq', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count, materialIds: materialIds.length ? materialIds : undefined }),
      });
      state.loading = false;
      if (data.error) { alert(data.error); render(); return; }
      state.quizQuestions = data.questions; state.quizType = 'frq';
      state.quizAnswers = {}; state.quizSubmitted = false; state.quizGrades = {};
      await loadClassData();
    }

    async function generateStudyGuide() {
      const topic = document.getElementById('guide-topic')?.value?.trim() || '';
      const materialIds = getSelectedMaterials();
      state.loading = true; state.loadingMsg = 'Creating study guide...'; render();
      const data = await api('/api/classes/' + state.currentClass.id + '/generate/study-guide', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, materialIds: materialIds.length ? materialIds : undefined }),
      });
      state.loading = false;
      if (data.error) { alert(data.error); render(); return; }
      state.viewingGuide = data;
      await loadClassData();
    }

    function getSelectedMaterials() {
      return Array.from(document.querySelectorAll('.mat-select:checked')).map(c => c.value);
    }

    function submitMCQ() { state.quizSubmitted = true; render(); }

    async function gradeFRQ(index) {
      const answer = state.quizAnswers[index];
      if (!answer?.trim()) return;
      const q = state.quizQuestions[index];
      state.loading = true; state.loadingMsg = 'Grading question ' + (index + 1) + '...'; render();
      const result = await api('/api/grade-frq', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q.question, modelAnswer: q.answer, studentAnswer: answer, className: state.currentClass.name }),
      });
      state.loading = false; state.quizGrades[index] = result; render();
    }

    async function deleteQuestion(id) {
      await api('/api/questions/' + state.currentClass.id + '/' + id, { method: 'DELETE' });
      loadClassData();
    }

    async function deleteGuide(id) {
      await api('/api/study-guides/' + state.currentClass.id + '/' + id, { method: 'DELETE' });
      loadClassData();
    }

    function viewGuide(guide) { state.viewingGuide = guide; render(); }

    function render() {
      document.getElementById('app').innerHTML = renderSidebar() + renderMain();
      bindEvents();
    }

    function renderSidebar() {
      return '<div class="sidebar"><h1>StudyLab</h1><p class="subtitle">AI-powered study companion</p><ul class="class-list">' +
        state.classes.map(c =>
          '<li class="class-item ' + (state.currentClass?.id === c.id ? 'active' : '') + '" data-class-id="' + c.id + '">' +
          '<span class="class-dot" style="background:' + c.color + '"></span>' + c.short_name + '</li>'
        ).join('') + '</ul></div>';
    }

    function renderMain() {
      if (!state.currentClass) return '<div class="main"><div class="empty"><p>Select a class</p></div></div>';
      const cls = state.currentClass;
      return '<div class="main">' +
        '<h2 style="margin-bottom:4px;font-size:24px;">' + cls.name + '</h2>' +
        '<p style="color:var(--text2);margin-bottom:20px;font-size:14px;">' + state.materials.length + ' material' + (state.materials.length !== 1 ? 's' : '') + ' uploaded</p>' +
        '<div class="tabs">' + ['materials','practice','study-guides','history'].map(t =>
          '<button class="tab ' + (state.currentTab === t ? 'active' : '') + '" data-tab="' + t + '">' +
          (t === 'materials' ? 'Materials' : t === 'practice' ? 'Practice' : t === 'study-guides' ? 'Study Guides' : 'History') + '</button>'
        ).join('') + '</div>' +
        (state.loading ? '<div class="loading"><div class="spinner"></div>' + state.loadingMsg + '</div>' : renderTabContent()) +
        '</div>';
    }

    function renderTabContent() {
      switch (state.currentTab) {
        case 'materials': return renderMaterials();
        case 'practice': return renderPractice();
        case 'study-guides': return renderStudyGuides();
        case 'history': return renderHistory();
        default: return '';
      }
    }

    function renderMaterials() {
      return '<div class="card"><h2>Upload Study Material</h2>' +
        '<p style="color:var(--text2);font-size:13px;margin-bottom:16px;">Paste notes, upload files, or enter content directly. This becomes the source for generating questions and study guides.</p>' +
        '<div class="form-group"><label>Title</label><input type="text" id="mat-title" placeholder="e.g., Chapter 5 Notes, Lab 3 Data..."></div>' +
        '<div class="form-group"><label>Content (paste notes, text, etc.)</label><textarea id="mat-content" placeholder="Paste your notes, textbook excerpts, lecture content..." rows="6"></textarea></div>' +
        '<div class="form-group"><label>Or upload a file (PDF, TXT, MD, etc.)</label><input type="file" id="mat-file" accept=".txt,.md,.csv,.json,.html,.pdf"></div>' +
        '<button class="btn btn-primary" onclick="uploadMaterial()">Upload Material</button></div>' +
        (state.materials.length ?
          '<div class="card"><h2>Uploaded Materials</h2>' + state.materials.map(m =>
            '<div class="material-item"><div><div class="name">' + esc(m.title) + '</div><div class="meta">' +
            (m.file_name ? m.file_name + ' \\u00b7 ' : '') + new Date(m.created_at).toLocaleDateString() +
            '</div></div><button class="btn btn-danger" onclick="deleteMaterial(\\'' + m.id + '\\')">Delete</button></div>'
          ).join('') + '</div>'
          : '<div class="empty"><div class="big">+</div><p>No materials yet. Upload some notes to get started!</p></div>');
    }

    function renderPractice() {
      if (state.quizQuestions) return state.quizType === 'mcq' ? renderMCQQuiz() : renderFRQQuiz();
      if (state.materials.length === 0) return '<div class="card"><h2>Generate Practice Questions</h2><p style="color:var(--text2);font-size:14px;">Upload materials first, then come back to generate questions.</p></div>';
      return '<div class="card"><h2>Generate Practice Questions</h2>' +
        '<h3>Select materials to use (or leave unchecked to use all)</h3>' +
        state.materials.map(m => '<label class="material-check"><input type="checkbox" class="mat-select" value="' + m.id + '">' + esc(m.title) + '</label>').join('') +
        '<div style="margin-top:20px;"><h3>Multiple Choice</h3><div class="gen-row"><div class="form-group"><label># Questions</label>' +
        '<select id="mcq-count"><option value="5">5</option><option value="10">10</option><option value="15">15</option><option value="20">20</option></select></div>' +
        '<button class="btn btn-primary" onclick="generateMCQ()">Generate MCQ</button></div></div>' +
        '<div style="margin-top:20px;"><h3>Free Response</h3><div class="gen-row"><div class="form-group"><label># Questions</label>' +
        '<select id="frq-count"><option value="2">2</option><option value="3">3</option><option value="5">5</option></select></div>' +
        '<button class="btn btn-primary" onclick="generateFRQ()">Generate FRQ</button></div></div></div>';
    }

    function renderMCQQuiz() {
      const qs = state.quizQuestions;
      let score = 0;
      if (state.quizSubmitted) qs.forEach((q, i) => { if (state.quizAnswers[i] === q.answer) score++; });
      return (state.quizSubmitted ? '<div class="score-banner"><div class="score-big">' + score + ' / ' + qs.length + '</div><div class="score-label">' + Math.round(score/qs.length*100) + '% correct</div></div>' : '') +
        qs.map((q, i) => {
          const selected = state.quizAnswers[i];
          const submitted = state.quizSubmitted;
          return '<div class="question-card"><div class="question-num">Question ' + (i+1) + '</div><div class="question-text">' + esc(q.question) + '</div>' +
            q.options.map(opt => {
              const letter = opt.charAt(0);
              let cls = 'option';
              if (submitted) { if (letter === q.answer) cls += ' correct'; else if (letter === selected) cls += ' incorrect'; }
              else if (letter === selected) cls += ' selected';
              return '<div class="' + cls + '" data-q="' + i + '" data-a="' + letter + '">' + esc(opt) + '</div>';
            }).join('') +
            (submitted ? '<div class="explanation"><strong>Answer: ' + q.answer + '</strong> \\u2014 ' + esc(q.explanation) + '</div>' : '') +
            '</div>';
        }).join('') +
        '<div style="display:flex;gap:10px;margin-top:10px;">' +
        (!state.quizSubmitted ? '<button class="btn btn-primary" onclick="submitMCQ()">Submit Answers</button>' : '') +
        '<button class="btn btn-secondary" onclick="state.quizQuestions=null;render();">Back to Practice</button></div>';
    }

    function renderFRQQuiz() {
      return state.quizQuestions.map((q, i) => {
        const grade = state.quizGrades[i];
        return '<div class="question-card"><div class="question-num">Question ' + (i+1) + ' <span class="badge badge-frq">FRQ</span></div>' +
          '<div class="question-text">' + esc(q.question) + '</div><div class="frq-answer-area">' +
          '<textarea id="frq-answer-' + i + '" placeholder="Write your answer here..." rows="5" oninput="state.quizAnswers[' + i + ']=this.value">' + (state.quizAnswers[i] || '') + '</textarea>' +
          '<div style="margin-top:8px;display:flex;gap:8px;">' +
          '<button class="btn btn-primary btn-sm" onclick="gradeFRQ(' + i + ')">Grade My Answer</button>' +
          '<button class="btn btn-secondary btn-sm" onclick="document.getElementById(\\'model-' + i + '\\').style.display=\\'block\\'">Show Model Answer</button></div>' +
          '<div id="model-' + i + '" style="display:none;margin-top:12px;" class="explanation"><strong>Model Answer:</strong><br>' + esc(q.answer) +
          (q.explanation ? '<br><br><strong>Key Points:</strong> ' + esc(q.explanation) : '') + '</div>' +
          (grade ? '<div class="grade-result"><div class="score">' + grade.score + '/10</div><div class="feedback">' + esc(grade.feedback) + '</div>' +
            (grade.suggestions ? '<div style="margin-top:8px;color:var(--text2);font-size:13px;"><strong>To improve:</strong> ' + esc(grade.suggestions) + '</div>' : '') + '</div>' : '') +
          '</div></div>';
      }).join('') +
      '<button class="btn btn-secondary" onclick="state.quizQuestions=null;render();" style="margin-top:10px;">Back to Practice</button>';
    }

    function renderStudyGuides() {
      if (state.viewingGuide) {
        return '<button class="btn btn-secondary" onclick="state.viewingGuide=null;render();" style="margin-bottom:16px;">Back</button>' +
          '<div class="card"><h2>' + esc(state.viewingGuide.title) + '</h2><div class="study-guide-content">' + marked.parse(state.viewingGuide.content) + '</div></div>';
      }
      return '<div class="card"><h2>Generate Study Guide</h2>' +
        (state.materials.length === 0 ? '<p style="color:var(--text2);font-size:14px;">Upload materials first.</p>' :
          '<h3>Select materials to use (or leave unchecked to use all)</h3>' +
          state.materials.map(m => '<label class="material-check"><input type="checkbox" class="mat-select" value="' + m.id + '">' + esc(m.title) + '</label>').join('') +
          '<div class="form-group" style="margin-top:16px;"><label>Focus topic (optional)</label><input type="text" id="guide-topic" placeholder="e.g., Integration by Parts, Acid-Base Equilibrium..."></div>' +
          '<button class="btn btn-primary" onclick="generateStudyGuide()">Generate Study Guide</button>') +
        '</div>' +
        (state.studyGuides.length ? '<div class="card"><h2>Saved Study Guides</h2>' +
          state.studyGuides.map(g =>
            '<div class="saved-item" data-guide-id="' + g.id + '"><div class="info"><div class="title">' + esc(g.title) + '</div><div class="date">' +
            new Date(g.created_at).toLocaleDateString() + '</div></div>' +
            '<button class="btn btn-danger" onclick="event.stopPropagation();deleteGuide(\\'' + g.id + '\\')">Delete</button></div>'
          ).join('') + '</div>' : '');
    }

    function renderHistory() {
      const mcqs = state.questions.filter(q => q.type === 'mcq');
      const frqs = state.questions.filter(q => q.type === 'frq');
      if (!state.questions.length) return '<div class="empty"><div class="big">?</div><p>No questions generated yet. Go to Practice to create some!</p></div>';
      return '<div class="card"><h2>Generated Questions</h2><p style="color:var(--text2);font-size:13px;margin-bottom:16px;">' + mcqs.length + ' MCQ \\u00b7 ' + frqs.length + ' FRQ</p>' +
        state.questions.map(q =>
          '<div class="saved-item" style="cursor:default;"><div class="info"><div class="title"><span class="badge ' +
          (q.type === 'mcq' ? 'badge-mcq' : 'badge-frq') + '">' + q.type.toUpperCase() + '</span> ' +
          esc(q.question.substring(0, 80)) + (q.question.length > 80 ? '...' : '') +
          '</div><div class="date">' + new Date(q.created_at).toLocaleDateString() + '</div></div>' +
          '<button class="btn btn-danger" onclick="deleteQuestion(\\'' + q.id + '\\')">Delete</button></div>'
        ).join('') + '</div>';
    }

    function bindEvents() {
      document.querySelectorAll('[data-class-id]').forEach(el => {
        el.addEventListener('click', () => selectClass(state.classes.find(c => c.id === el.dataset.classId)));
      });
      document.querySelectorAll('[data-tab]').forEach(el => {
        el.addEventListener('click', () => selectTab(el.dataset.tab));
      });
      document.querySelectorAll('.option[data-q]').forEach(el => {
        el.addEventListener('click', () => {
          if (state.quizSubmitted) return;
          state.quizAnswers[parseInt(el.dataset.q)] = el.dataset.a;
          render();
        });
      });
      document.querySelectorAll('[data-guide-id]').forEach(el => {
        el.addEventListener('click', () => {
          const g = state.studyGuides.find(g => g.id === el.dataset.guideId);
          if (g) viewGuide(g);
        });
      });
    }

    function esc(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    loadClasses().then(loadClassData);
  </script>
</body>
</html>`;
