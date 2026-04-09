import { Hono } from "https://deno.land/x/hono@v4.3.6/mod.ts";
import { cors } from "https://deno.land/x/hono@v4.3.6/middleware/cors/index.ts";
import Anthropic from "npm:@anthropic-ai/sdk";
// PDF parsing moved to client-side for speed

const app = new Hono();
const kv = await Deno.openKv();

app.use("/*", cors());

// Global error handler
app.onError((err, c) => {
  console.error("Server error:", err.message, err.stack);
  return c.json({ error: err.message }, 500);
});

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

// --- API: Materials (now with image support) ---
app.get("/api/classes/:id/materials", async (c) => {
  const materials = await kvList(["materials", c.req.param("id")]);
  // Don't send full image data in list view
  const slim = (materials as any[]).map(m => ({
    ...m,
    images: m.images ? m.images.map((img: any) => ({ name: img.name, type: img.type })) : [],
    content: m.content ? m.content.substring(0, 200) + (m.content.length > 200 ? '...' : '') : '',
  }));
  slim.sort((a: any, b: any) => (b.created_at || "").localeCompare(a.created_at || ""));
  return c.json(slim);
});

app.post("/api/classes/:id/materials", async (c) => {
  const classId = c.req.param("id");
  const body = await c.req.parseBody({ all: true });

  const title = (body["title"] as string) || "Untitled";
  let content = (body["content"] as string) || "";
  let fileName = null;
  const images: { name: string; type: string; data: string }[] = [];

  // Handle file upload
  const file = body["file"] as File | undefined;
  if (file && file.size > 0) {
    fileName = file.name;
    const arrayBuffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    const ext = file.name.toLowerCase().split('.').pop();

    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext || '')) {
      // Store image as base64
      const base64 = btoa(String.fromCharCode(...uint8));
      const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      images.push({ name: file.name, type: mimeType, data: base64 });
      if (!content) content = `[Image: ${file.name}]`;
    } else {
      content = await file.text();
    }
  }

  // Handle multiple image uploads
  const imageFiles = body["images"];
  if (imageFiles) {
    const fileList = Array.isArray(imageFiles) ? imageFiles : [imageFiles];
    for (const img of fileList) {
      if (img instanceof File && img.size > 0) {
        const ext = img.name.toLowerCase().split('.').pop();
        if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext || '')) {
          const buf = await img.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
          const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          images.push({ name: img.name, type: mimeType, data: base64 });
        }
      }
    }
    if (!content && images.length) content = `[${images.length} image(s) uploaded]`;
  }

  if (!String(content || "").trim() && images.length === 0) {
    return c.json({ error: "No content provided" }, 400);
  }

  const id = genId();
  const material = {
    id, class_id: classId, title, content,
    file_name: fileName, images,
    has_images: images.length > 0,
    created_at: new Date().toISOString(),
  };
  await kv.set(["materials", classId, id], material);

  return c.json({ id, title, file_name: fileName, has_images: images.length > 0 }, 201);
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

async function getMaterialsFull(classId: string, materialIds?: string[]) {
  const all = await kvList<any>(["materials", classId]);
  if (materialIds && materialIds.length > 0) {
    return all.filter(m => materialIds.includes(m.id));
  }
  return all;
}

// Build Claude message content with text + images
function buildMaterialContent(materials: any[], prompt: string): any[] {
  const contentParts: any[] = [];

  // Add images from materials
  for (const m of materials) {
    if (m.images && m.images.length > 0) {
      for (const img of m.images) {
        contentParts.push({
          type: "image",
          source: { type: "base64", media_type: img.type, data: img.data },
        });
        contentParts.push({
          type: "text",
          text: `[Image from material: ${m.title} - ${img.name}]`,
        });
      }
    }
  }

  // Add text content
  const materialText = materials
    .filter(m => m.content && !m.content.startsWith('[Image:') && !m.content.startsWith('['))
    .map(m => `--- ${m.title} ---\n${m.content}`)
    .join("\n\n");

  contentParts.push({ type: "text", text: prompt + (materialText ? `\n\nMATERIALS:\n${materialText}` : '') });

  return contentParts;
}

app.post("/api/classes/:id/generate/mcq", async (c) => {
  const classId = c.req.param("id");
  const { count = 5, materialIds } = await c.req.json();

  const cls = (await kv.get(["classes", classId])).value as { name: string };
  const materials = await getMaterialsFull(classId, materialIds);

  if (materials.length === 0) {
    return c.json({ error: "No materials uploaded for this class yet" }, 400);
  }

  const client = getClient();
  const content = buildMaterialContent(materials,
    `You are a study assistant for a high school student in ${cls.name}. Based on the following study materials (including any images), generate ${count} multiple choice questions.

Return ONLY a JSON array with this exact format (no markdown, no code fences):
[
  {
    "question": "Question text here?",
    "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
    "answer": "A",
    "explanation": "Brief explanation of why this is correct"
  }
]`);

  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content }],
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text : "";
  let questions;
  try { questions = JSON.parse(text); }
  catch { const match = text.match(/\[[\s\S]*\]/); questions = match ? JSON.parse(match[0]) : []; }

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
  const materials = await getMaterialsFull(classId, materialIds);

  if (materials.length === 0) {
    return c.json({ error: "No materials uploaded for this class yet" }, 400);
  }

  const client = getClient();
  const content = buildMaterialContent(materials,
    `You are a study assistant for a high school student in ${cls.name}. Based on the following study materials (including any images), generate ${count} free response questions that would appear on an AP exam or college-level assessment.

Return ONLY a JSON array with this exact format (no markdown, no code fences):
[
  {
    "question": "Full FRQ prompt with any necessary context or stimulus",
    "answer": "A thorough model answer that would receive full marks",
    "explanation": "Key points the grader would look for"
  }
]`);

  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content }],
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text : "";
  let questions;
  try { questions = JSON.parse(text); }
  catch { const match = text.match(/\[[\s\S]*\]/); questions = match ? JSON.parse(match[0]) : []; }

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
  const materials = await getMaterialsFull(classId, materialIds);

  if (materials.length === 0) {
    return c.json({ error: "No materials uploaded for this class yet" }, 400);
  }

  const client = getClient();
  const topicLine = topic ? `Focus on the topic: ${topic}` : "Cover the key concepts from the materials.";
  const content = buildMaterialContent(materials,
    `You are a study assistant for a high school student in ${cls.name}. Create a comprehensive study guide based on the following materials (including any images). ${topicLine}

Format the study guide in clean markdown with:
- A clear title
- Key concepts and definitions
- Important formulas/facts (if applicable)
- Common misconceptions
- Practice tips
- Summary

Make it easy to scan and review.`);

  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    messages: [{ role: "user", content }],
  });

  const guideContent = msg.content[0].type === "text" ? msg.content[0].text : "";
  const title = topic || `Study Guide - ${new Date().toLocaleDateString()}`;
  const id = genId();

  await kv.set(["study_guides", classId, id], {
    id, class_id: classId, title, content: guideContent, created_at: new Date().toISOString(),
  });

  return c.json({ id, title, content: guideContent });
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
  try { result = JSON.parse(text); }
  catch { const match = text.match(/\{[\s\S]*\}/); result = match ? JSON.parse(match[0]) : { score: 0, feedback: "Could not parse response", suggestions: "" }; }
  return c.json(result);
});

// --- API: Study Plans ---
app.get("/api/classes/:id/plans", async (c) => {
  const plans = await kvList(["plans", c.req.param("id")]);
  plans.sort((a: any, b: any) => (b.created_at || "").localeCompare(a.created_at || ""));
  return c.json(plans);
});

app.post("/api/classes/:id/plans", async (c) => {
  const classId = c.req.param("id");
  const { goal, duration, examDate } = await c.req.json();

  const cls = (await kv.get(["classes", classId])).value as { name: string };
  const materials = await getMaterialsFull(classId);

  const client = getClient();
  const materialSummary = materials.length > 0
    ? `The student has uploaded these materials: ${materials.map(m => m.title).join(", ")}`
    : "The student has not uploaded specific materials yet.";

  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: `You are a study planner for a high school student in ${cls.name}.

GOAL: ${goal}
STUDY DURATION: ${duration}
${examDate ? `EXAM/DUE DATE: ${examDate}` : ''}
${materialSummary}

Create a detailed study plan. Return ONLY JSON (no markdown, no code fences):
{
  "title": "Short plan title",
  "summary": "Brief overview of the plan approach",
  "steps": [
    {
      "day": "Day 1" or "Session 1",
      "title": "Step title",
      "description": "What to do in detail",
      "duration": "Estimated time like 30 min, 1 hour",
      "type": "review|practice|memorize|apply|rest"
    }
  ],
  "tips": ["Helpful tip 1", "Helpful tip 2"]
}`
    }]
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text : "";
  let plan;
  try { plan = JSON.parse(text); }
  catch { const match = text.match(/\{[\s\S]*\}/); plan = match ? JSON.parse(match[0]) : { title: "Study Plan", summary: "", steps: [], tips: [] }; }

  const id = genId();
  const steps = (plan.steps || []).map((s: any, i: number) => ({ ...s, id: i, completed: false }));

  const planData = {
    id, class_id: classId,
    title: plan.title, summary: plan.summary,
    goal, duration, exam_date: examDate || null,
    steps, tips: plan.tips || [],
    created_at: new Date().toISOString(),
  };

  await kv.set(["plans", classId, id], planData);
  return c.json(planData);
});

app.put("/api/plans/:classId/:id/step/:stepId", async (c) => {
  const { classId, id, stepId } = c.req.param();
  const { completed } = await c.req.json();

  const entry = await kv.get(["plans", classId, id]);
  if (!entry.value) return c.json({ error: "Plan not found" }, 404);

  const plan = entry.value as any;
  const step = plan.steps.find((s: any) => s.id === parseInt(stepId));
  if (step) step.completed = completed;

  await kv.set(["plans", classId, id], plan);
  return c.json({ ok: true });
});

app.delete("/api/plans/:classId/:id", async (c) => {
  await kv.delete(["plans", c.req.param("classId"), c.req.param("id")]);
  return c.json({ ok: true });
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

// --- Serve HTML (only for non-API routes) ---
app.get("*", (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
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
    .tabs { display: flex; gap: 4px; background: var(--surface); border-radius: 10px; padding: 4px; margin-bottom: 28px; flex-wrap: wrap; }
    .tab { padding: 8px 18px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; color: var(--text2); border: none; background: none; transition: all 0.15s; }
    .tab:hover { color: var(--text); }
    .tab.active { background: var(--accent); color: white; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; margin-bottom: 20px; }
    .card h2 { font-size: 18px; margin-bottom: 16px; }
    .card h3 { font-size: 15px; color: var(--text2); margin-bottom: 12px; font-weight: 500; }
    .btn { padding: 10px 20px; border-radius: 8px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s; display: inline-flex; align-items: center; gap: 8px; }
    .btn-primary { background: var(--accent); color: white; }
    .btn-primary:hover { background: var(--accent2); }
    .btn-secondary { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { border-color: var(--accent); }
    .btn-danger { background: transparent; color: var(--red); border: 1px solid var(--red); padding: 6px 12px; font-size: 12px; }
    .btn-danger:hover { background: var(--red); color: white; }
    .btn-sm { padding: 6px 14px; font-size: 13px; }
    .btn-success { background: var(--green); color: white; }
    .btn-success:hover { opacity: 0.9; }
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
    .badge-img { background: rgba(236, 72, 153, 0.15); color: #ec4899; }
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
    /* Study Plan styles */
    .plan-step { display: flex; gap: 14px; padding: 16px; background: var(--surface2); border-radius: 8px; margin-bottom: 8px; align-items: flex-start; border-left: 3px solid var(--border); transition: all 0.2s; }
    .plan-step.completed { border-left-color: var(--green); opacity: 0.7; }
    .plan-step .step-check { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--border); cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; margin-top: 2px; transition: all 0.15s; }
    .plan-step .step-check:hover { border-color: var(--green); }
    .plan-step.completed .step-check { background: var(--green); border-color: var(--green); }
    .plan-step .step-body { flex: 1; }
    .plan-step .step-day { font-size: 11px; color: var(--accent2); font-weight: 600; text-transform: uppercase; }
    .plan-step .step-title { font-weight: 600; font-size: 15px; margin: 4px 0; }
    .plan-step .step-desc { font-size: 13px; color: var(--text2); line-height: 1.5; }
    .plan-step .step-dur { font-size: 12px; color: var(--text2); margin-top: 6px; display: inline-flex; align-items: center; gap: 4px; background: var(--surface); padding: 2px 8px; border-radius: 4px; }
    .plan-step .step-type { font-size: 11px; padding: 2px 8px; border-radius: 4px; margin-left: 6px; font-weight: 600; text-transform: uppercase; }
    .type-review { background: rgba(99,102,241,0.15); color: var(--accent2); }
    .type-practice { background: rgba(16,185,129,0.15); color: var(--green); }
    .type-memorize { background: rgba(245,158,11,0.15); color: var(--yellow); }
    .type-apply { background: rgba(236,72,153,0.15); color: #ec4899; }
    .type-rest { background: rgba(148,148,168,0.15); color: var(--text2); }
    .plan-progress { height: 6px; background: var(--surface2); border-radius: 3px; margin: 12px 0; overflow: hidden; }
    .plan-progress-bar { height: 100%; background: linear-gradient(90deg, var(--accent), var(--green)); border-radius: 3px; transition: width 0.3s; }
    .plan-tips { margin-top: 16px; padding: 16px; background: rgba(99,102,241,0.05); border-radius: 8px; border: 1px solid var(--border); }
    .plan-tips h4 { font-size: 14px; color: var(--accent2); margin-bottom: 8px; }
    .upload-progress { width: 100%; margin: 12px 0; }
    .upload-progress-bar { height: 8px; background: var(--surface2); border-radius: 4px; overflow: hidden; }
    .upload-progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--green)); border-radius: 4px; transition: width 0.2s; }
    .upload-progress-text { font-size: 12px; color: var(--text2); margin-top: 4px; }
    .plan-tips li { font-size: 13px; color: var(--text2); margin-bottom: 4px; }
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
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs" type="module"></script>
  <script>
    // PDF text extraction (client-side) with progress + chunking
    async function extractPdfPages(file, onProgress) {
      const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.map(item => item.str).join(' '));
        if (onProgress) onProgress(i, pdf.numPages);
      }
      return pages;
    }

    function chunkPages(pages, maxChars) {
      const chunks = [];
      let current = []; let currentLen = 0; let startPage = 1;
      for (let i = 0; i < pages.length; i++) {
        const pageLen = pages[i].length;
        if (currentLen + pageLen > maxChars && current.length > 0) {
          chunks.push({ text: current.join('\n'), startPage, endPage: i });
          current = []; currentLen = 0; startPage = i + 1;
        }
        current.push(pages[i]); currentLen += pageLen;
      }
      if (current.length > 0) {
        chunks.push({ text: current.join('\n'), startPage, endPage: pages.length });
      }
      return chunks;
    }
  </script>
  <script>
    const API = '';
    let state = {
      classes: [], currentClass: null, currentTab: 'materials',
      materials: [], questions: [], studyGuides: [], plans: [],
      quizQuestions: null, quizType: null, quizAnswers: {}, quizSubmitted: false, quizGrades: {},
      viewingGuide: null, viewingPlan: null,
      loading: false, loadingMsg: '', progressPct: null,
    };

    async function api(path, opts = {}) { const res = await fetch(API + path, opts); return res.json(); }

    async function loadClasses() {
      state.classes = await api('/api/classes');
      if (!state.currentClass && state.classes.length) state.currentClass = state.classes[0];
      render();
    }

    async function loadClassData() {
      if (!state.currentClass) return;
      const id = state.currentClass.id;
      const [materials, questions, guides, plans] = await Promise.all([
        api('/api/classes/' + id + '/materials'),
        api('/api/classes/' + id + '/questions'),
        api('/api/classes/' + id + '/study-guides'),
        api('/api/classes/' + id + '/plans'),
      ]);
      state.materials = materials;
      state.questions = questions;
      state.studyGuides = guides;
      state.plans = plans;
      render();
    }

    function selectClass(cls) {
      state.currentClass = cls; state.currentTab = 'materials';
      state.quizQuestions = null; state.viewingGuide = null; state.viewingPlan = null;
      loadClassData();
    }

    function selectTab(tab) {
      state.currentTab = tab; state.quizQuestions = null; state.viewingGuide = null; state.viewingPlan = null; render();
    }

    async function uploadMaterial() {
      const title = document.getElementById('mat-title').value.trim();
      let content = document.getElementById('mat-content').value.trim();
      const fileInput = document.getElementById('mat-file');
      const imageInput = document.getElementById('mat-images');
      const file = fileInput?.files?.[0];
      const images = imageInput?.files;

      if (!title && !file && !content && (!images || images.length === 0)) {
        alert('Please provide a title and content, a file, or images'); return;
      }

      state.loading = true; state.progressPct = null; state.loadingMsg = 'Processing...'; render();
      const baseTitle = title || (file ? file.name.replace(/\\.pdf$/i, '') : (images?.length ? 'Image Upload' : 'Untitled'));

      // Handle PDF with chunked upload
      if (file && file.name.toLowerCase().endsWith('.pdf')) {
        try {
          state.loadingMsg = 'Extracting text from PDF...'; state.progressPct = 0; render();
          const pages = await extractPdfPages(file, (current, total) => {
            state.progressPct = Math.round((current / total) * 100);
            state.loadingMsg = 'Extracting page ' + current + ' of ' + total + '...';
            render();
          });

          const chunks = chunkPages(pages, 50000);
          state.loadingMsg = 'Uploading...'; state.progressPct = 0; render();

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkTitle = chunks.length === 1 ? baseTitle : baseTitle + ' (Pages ' + chunk.startPage + '-' + chunk.endPage + ')';
            const form = new FormData();
            form.append('title', chunkTitle);
            form.append('content', chunk.text);
            if (images) { for (const img of images) form.append('images', img); }
            state.progressPct = Math.round(((i + 1) / chunks.length) * 100);
            state.loadingMsg = 'Uploading chunk ' + (i + 1) + ' of ' + chunks.length + '...';
            render();
            await api('/api/classes/' + state.currentClass.id + '/materials', { method: 'POST', body: form });
          }
        } catch(e) {
          console.error('PDF extraction failed:', e);
          alert('PDF extraction failed: ' + e.message);
        }
        state.loading = false; state.progressPct = null;
        await loadClassData();
        return;
      }

      // Non-PDF upload
      const form = new FormData();
      form.append('title', baseTitle);
      if (content) form.append('content', content);
      if (file) form.append('file', file);
      if (images) { for (const img of images) form.append('images', img); }

      state.loadingMsg = 'Uploading...'; render();
      await api('/api/classes/' + state.currentClass.id + '/materials', { method: 'POST', body: form });
      state.loading = false; state.progressPct = null;
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

    async function createPlan() {
      const goal = document.getElementById('plan-goal')?.value?.trim();
      const duration = document.getElementById('plan-duration')?.value?.trim();
      const examDate = document.getElementById('plan-exam')?.value?.trim();
      if (!goal || !duration) { alert('Please enter a study goal and duration'); return; }
      state.loading = true; state.loadingMsg = 'Creating your study plan...'; render();
      const data = await api('/api/classes/' + state.currentClass.id + '/plans', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal, duration, examDate }),
      });
      state.loading = false;
      if (data.error) { alert(data.error); render(); return; }
      state.viewingPlan = data;
      await loadClassData();
    }

    async function toggleStep(planId, stepId, completed) {
      await api('/api/plans/' + state.currentClass.id + '/' + planId + '/step/' + stepId, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed }),
      });
      // Update local state
      if (state.viewingPlan && state.viewingPlan.id === planId) {
        const step = state.viewingPlan.steps.find(s => s.id === stepId);
        if (step) step.completed = completed;
      }
      const plan = state.plans.find(p => p.id === planId);
      if (plan && plan.steps) {
        const step = plan.steps.find(s => s.id === stepId);
        if (step) step.completed = completed;
      }
      render();
    }

    async function deletePlan(id) {
      await api('/api/plans/' + state.currentClass.id + '/' + id, { method: 'DELETE' });
      state.viewingPlan = null;
      loadClassData();
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

    async function deleteQuestion(id) { await api('/api/questions/' + state.currentClass.id + '/' + id, { method: 'DELETE' }); loadClassData(); }
    async function deleteGuide(id) { await api('/api/study-guides/' + state.currentClass.id + '/' + id, { method: 'DELETE' }); loadClassData(); }
    function viewGuide(guide) { state.viewingGuide = guide; render(); }
    function viewPlan(plan) { state.viewingPlan = plan; render(); }

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
      const tabs = ['materials','practice','study-guides','study-plan','history'];
      const tabLabels = { materials: 'Materials', practice: 'Practice', 'study-guides': 'Study Guides', 'study-plan': 'Study Plan', history: 'History' };
      return '<div class="main">' +
        '<h2 style="margin-bottom:4px;font-size:24px;">' + cls.name + '</h2>' +
        '<p style="color:var(--text2);margin-bottom:20px;font-size:14px;">' + state.materials.length + ' material' + (state.materials.length !== 1 ? 's' : '') + ' uploaded</p>' +
        '<div class="tabs">' + tabs.map(t =>
          '<button class="tab ' + (state.currentTab === t ? 'active' : '') + '" data-tab="' + t + '">' + tabLabels[t] + '</button>'
        ).join('') + '</div>' +
        (state.loading ? '<div class="loading"><div class="spinner"></div>' + state.loadingMsg + (state.progressPct != null ? '<div class="upload-progress"><div class="upload-progress-bar"><div class="upload-progress-fill" style="width:' + state.progressPct + '%"></div></div><div class="upload-progress-text">' + state.progressPct + '%</div></div>' : '') + '</div>' : renderTabContent()) +
        '</div>';
    }

    function renderTabContent() {
      switch (state.currentTab) {
        case 'materials': return renderMaterials();
        case 'practice': return renderPractice();
        case 'study-guides': return renderStudyGuides();
        case 'study-plan': return renderStudyPlan();
        case 'history': return renderHistory();
        default: return '';
      }
    }

    function renderMaterials() {
      return '<div class="card"><h2>Upload Study Material</h2>' +
        '<p style="color:var(--text2);font-size:13px;margin-bottom:16px;">Paste notes, upload files (PDF, images, text), or enter content directly.</p>' +
        '<div class="form-group"><label>Title</label><input type="text" id="mat-title" placeholder="e.g., Chapter 5 Notes, Lab 3 Data..."></div>' +
        '<div class="form-group"><label>Content (paste notes, text, etc.)</label><textarea id="mat-content" placeholder="Paste your notes, textbook excerpts, lecture content..." rows="6"></textarea></div>' +
        '<div class="form-group"><label>Upload a file (PDF, TXT, MD, images)</label><input type="file" id="mat-file" accept=".txt,.md,.csv,.json,.html,.pdf,.png,.jpg,.jpeg,.gif,.webp"></div>' +
        '<div class="form-group"><label>Upload images (select multiple)</label><input type="file" id="mat-images" accept="image/*" multiple></div>' +
        '<button class="btn btn-primary" onclick="uploadMaterial()">Upload Material</button></div>' +
        (state.materials.length ?
          '<div class="card"><h2>Uploaded Materials</h2>' + state.materials.map(m =>
            '<div class="material-item"><div><div class="name">' + esc(m.title) +
            (m.has_images ? ' <span class="badge badge-img">IMG</span>' : '') +
            '</div><div class="meta">' +
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
        state.materials.map(m => '<label class="material-check"><input type="checkbox" class="mat-select" value="' + m.id + '">' + esc(m.title) +
          (m.has_images ? ' <span class="badge badge-img">IMG</span>' : '') + '</label>').join('') +
        '<div style="margin-top:20px;"><h3>Multiple Choice</h3><div class="gen-row"><div class="form-group"><label># Questions</label>' +
        '<select id="mcq-count"><option value="5">5</option><option value="10">10</option><option value="15">15</option><option value="20">20</option></select></div>' +
        '<button class="btn btn-primary" onclick="generateMCQ()">Generate MCQ</button></div></div>' +
        '<div style="margin-top:20px;"><h3>Free Response</h3><div class="gen-row"><div class="form-group"><label># Questions</label>' +
        '<select id="frq-count"><option value="2">2</option><option value="3">3</option><option value="5">5</option></select></div>' +
        '<button class="btn btn-primary" onclick="generateFRQ()">Generate FRQ</button></div></div></div>';
    }

    function renderMCQQuiz() {
      const qs = state.quizQuestions; let score = 0;
      if (state.quizSubmitted) qs.forEach((q, i) => { if (state.quizAnswers[i] === q.answer) score++; });
      return (state.quizSubmitted ? '<div class="score-banner"><div class="score-big">' + score + ' / ' + qs.length + '</div><div class="score-label">' + Math.round(score/qs.length*100) + '% correct</div></div>' : '') +
        qs.map((q, i) => {
          const selected = state.quizAnswers[i]; const submitted = state.quizSubmitted;
          return '<div class="question-card"><div class="question-num">Question ' + (i+1) + '</div><div class="question-text">' + esc(q.question) + '</div>' +
            q.options.map(opt => {
              const letter = opt.charAt(0); let cls = 'option';
              if (submitted) { if (letter === q.answer) cls += ' correct'; else if (letter === selected) cls += ' incorrect'; }
              else if (letter === selected) cls += ' selected';
              return '<div class="' + cls + '" data-q="' + i + '" data-a="' + letter + '">' + esc(opt) + '</div>';
            }).join('') +
            (submitted ? '<div class="explanation"><strong>Answer: ' + q.answer + '</strong> \\u2014 ' + esc(q.explanation) + '</div>' : '') + '</div>';
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

    function renderStudyPlan() {
      if (state.viewingPlan) return renderPlanDetail(state.viewingPlan);

      return '<div class="card"><h2>Create a Study Plan</h2>' +
        '<p style="color:var(--text2);font-size:13px;margin-bottom:16px;">Tell me what you want to study and how long you have. I\\'ll create a structured plan with steps you can check off.</p>' +
        '<div class="form-group"><label>Study Goal</label><textarea id="plan-goal" placeholder="e.g., Master integration techniques for the AP Calc BC exam, Review all acid-base chemistry concepts..." rows="3"></textarea></div>' +
        '<div class="gen-row">' +
        '<div class="form-group"><label>Duration</label><input type="text" id="plan-duration" placeholder="e.g., 3 days, 1 week, 2 hours"></div>' +
        '<div class="form-group"><label>Exam/Due Date (optional)</label><input type="date" id="plan-exam"></div>' +
        '</div>' +
        '<button class="btn btn-primary" onclick="createPlan()" style="margin-top:16px;">Create Study Plan</button></div>' +
        (state.plans.length ? '<div class="card"><h2>Your Study Plans</h2>' +
          state.plans.map(p => {
            const done = (p.steps || []).filter(s => s.completed).length;
            const total = (p.steps || []).length;
            const pct = total > 0 ? Math.round(done/total*100) : 0;
            return '<div class="saved-item" data-plan-id="' + p.id + '"><div class="info"><div class="title">' + esc(p.title) + '</div>' +
              '<div class="date">' + done + '/' + total + ' steps done (' + pct + '%) \\u00b7 ' + new Date(p.created_at).toLocaleDateString() + '</div></div>' +
              '<button class="btn btn-danger" onclick="event.stopPropagation();deletePlan(\\'' + p.id + '\\')">Delete</button></div>';
          }).join('') + '</div>' : '');
    }

    function renderPlanDetail(plan) {
      const done = plan.steps.filter(s => s.completed).length;
      const total = plan.steps.length;
      const pct = total > 0 ? Math.round(done/total*100) : 0;

      return '<button class="btn btn-secondary" onclick="state.viewingPlan=null;render();" style="margin-bottom:16px;">Back to Plans</button>' +
        '<div class="card"><h2>' + esc(plan.title) + '</h2>' +
        '<p style="color:var(--text2);font-size:14px;margin-bottom:4px;">' + esc(plan.goal) + '</p>' +
        '<p style="color:var(--text2);font-size:13px;">Duration: ' + esc(plan.duration) +
        (plan.exam_date ? ' \\u00b7 Exam: ' + plan.exam_date : '') + '</p>' +
        '<div style="margin:16px 0;"><p style="font-size:13px;color:var(--text2);margin-bottom:4px;">' + done + ' of ' + total + ' steps complete (' + pct + '%)</p>' +
        '<div class="plan-progress"><div class="plan-progress-bar" style="width:' + pct + '%"></div></div></div>' +
        (plan.summary ? '<p style="font-size:14px;margin-bottom:16px;">' + esc(plan.summary) + '</p>' : '') +
        plan.steps.map(s =>
          '<div class="plan-step ' + (s.completed ? 'completed' : '') + '">' +
          '<div class="step-check" data-plan="' + plan.id + '" data-step="' + s.id + '" data-done="' + (s.completed ? '1' : '0') + '">' +
          (s.completed ? '\\u2713' : '') + '</div>' +
          '<div class="step-body"><div class="step-day">' + esc(s.day) +
          '<span class="step-type type-' + (s.type || 'review') + '">' + esc(s.type || 'review') + '</span></div>' +
          '<div class="step-title">' + esc(s.title) + '</div>' +
          '<div class="step-desc">' + esc(s.description) + '</div>' +
          (s.duration ? '<span class="step-dur">\\u23f1 ' + esc(s.duration) + '</span>' : '') +
          '</div></div>'
        ).join('') +
        (plan.tips && plan.tips.length ? '<div class="plan-tips"><h4>Tips</h4><ul>' +
          plan.tips.map(t => '<li>' + esc(t) + '</li>').join('') + '</ul></div>' : '') +
        '</div>';
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
          state.quizAnswers[parseInt(el.dataset.q)] = el.dataset.a; render();
        });
      });
      document.querySelectorAll('[data-guide-id]').forEach(el => {
        el.addEventListener('click', () => {
          const g = state.studyGuides.find(g => g.id === el.dataset.guideId);
          if (g) viewGuide(g);
        });
      });
      document.querySelectorAll('[data-plan-id]').forEach(el => {
        el.addEventListener('click', () => {
          const p = state.plans.find(p => p.id === el.dataset.planId);
          if (p) viewPlan(p);
        });
      });
      document.querySelectorAll('.step-check').forEach(el => {
        el.addEventListener('click', () => {
          const planId = el.dataset.plan;
          const stepId = parseInt(el.dataset.step);
          const isDone = el.dataset.done === '1';
          toggleStep(planId, stepId, !isDone);
        });
      });
    }

    function esc(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = String(str);
      return div.innerHTML;
    }

    loadClasses().then(loadClassData);
  </script>
</body>
</html>`;
