require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const DAILY_LIMIT = 5;

// 相同输入返回相同结果
const responseCache = new Map();

// 每日限次：按 IP 统计
const dailyRequestStore = new Map();

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("没有提取到 JSON");
  }
  return JSON.parse(match[0]);
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

function getTodayKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }
  return (
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function buildCacheKey(userText) {
  const normalized = String(userText || "").trim();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function getDailyCounter(ip) {
  const today = getTodayKey();
  const key = `${today}:${ip}`;

  if (!dailyRequestStore.has(key)) {
    dailyRequestStore.set(key, { count: 0, date: today });
  }

  return { key, data: dailyRequestStore.get(key) };
}

function buildAnalysis(userText) {
  const text = (userText || "").trim();

  if (!text) {
    return {
      score: 0,
      hits: [],
      reasons: ["今天没有输入具体事件，只能按极低风险的普通状态处理。"],
      summary: "无明确事件",
      mode: "normal"
    };
  }

  let score = 0;
  const hits = [];
  const reasons = [];
  let mode = "normal";

  const rules = [
    {
      key: "selfHarm",
      words: [
        "轻生", "不想活", "想死", "自杀", "结束自己", "结束生命",
        "活着没意思", "不如死了", "想结束", "不想再活", "想消失"
      ],
      add: 35,
      reason: "你提到了轻生或结束生命的念头，这类信息不能当成普通情绪波动处理。",
      mode: "support"
    },
    {
      key: "criticalEmergency",
      words: ["胸痛", "呼吸困难", "喘不过气", "昏厥", "晕倒", "大出血", "心梗", "中风"],
      add: 28,
      reason: "你提到了胸痛、呼吸困难、昏厥或大出血这类高危信号，这会显著抬高今天的风险判断。",
      mode: "serious"
    },
    {
      key: "severeDisease",
      words: ["严重疾病", "重病", "癌", "肿瘤", "恶性", "住院", "急诊", "手术"],
      add: 20,
      reason: "你提到了严重疾病、住院或手术相关信息，这不是普通小波动，所以风险会明显上调。",
      mode: "serious"
    },
    {
      key: "seriousIllness",
      words: ["高烧", "肺炎", "感染严重", "持续发烧", "剧烈头痛", "剧烈腹痛"],
      add: 12,
      reason: "你提到比较明显的身体异常，说明今天状态并不轻松。"
    },
    {
      key: "illness",
      words: ["感冒", "发烧", "生病", "咳嗽", "头晕", "头痛", "难受", "不舒服"],
      add: 5,
      reason: "你提到了身体不适，这会让今天的风险解读略微上调。"
    },
    {
      key: "sleep",
      words: ["熬夜", "通宵", "没睡", "失眠", "只睡", "凌晨三点", "凌晨4点"],
      add: 4,
      reason: "睡眠不足会影响反应速度和注意力，所以今天不会按最稳状态处理。"
    },
    {
      key: "stress",
      words: ["焦虑", "压力大", "崩溃", "烦", "精神紧张", "情绪差", "高压", "皮质醇过高"],
      add: 3,
      reason: "精神压力会让状态更不稳定。"
    },
    {
      key: "traffic",
      words: ["开车", "骑车", "赶路", "赶飞机", "出差", "高速", "长途"],
      add: 3,
      reason: "今天如果还涉及赶路或移动，风险会再抬一点。"
    },
    {
      key: "alcohol",
      words: ["喝酒", "醉", "宿醉", "酒后"],
      add: 5,
      reason: "酒精或宿醉会影响判断和身体状态。"
    },
    {
      key: "foodEnergy",
      words: ["没吃饭", "低血糖", "很饿", "体力差", "乏力"],
      add: 3,
      reason: "体力和能量不足时，状态更容易掉线。"
    },
    {
      key: "rest",
      words: ["休息", "在家", "躺着", "卧床", "不出门"],
      add: -2,
      reason: "低活动场景会略微降低外部风险暴露。"
    },
    {
      key: "stable",
      words: ["睡得好", "稳定", "正常", "状态不错", "精神不错", "今天挺好"],
      add: -2,
      reason: "你提到整体状态尚可，这会稍微压低风险。"
    }
  ];

  for (const rule of rules) {
    if (includesAny(text, rule.words)) {
      score += rule.add;
      hits.push(rule.key);
      reasons.push(rule.reason);
      if (rule.mode === "support") mode = "support";
      else if (rule.mode === "serious" && mode !== "support") mode = "serious";
    }
  }

  score = clamp(score, 0, 40);

  return {
    score,
    hits,
    reasons: reasons.length ? reasons : ["没有明显高危线索，更接近普通日常波动。"],
    summary: reasons.length ? reasons[0] : "普通日常状态",
    mode
  };
}

function mapScoreToProbability(score, hits = [], hasInput = false) {
  if (!hasInput) {
    return Number((Math.random() * 0.7 + 0.1).toFixed(1)); // 0.1 ~ 0.8
  }

  if (hits.includes("selfHarm")) {
    return Number((Math.random() * 2.0 + 7.0).toFixed(1)); // 7.0 ~ 9.0
  }

  if (hits.includes("criticalEmergency")) {
    return Number((Math.random() * 3.0 + 6.0).toFixed(1)); // 6.0 ~ 9.0
  }

  if (hits.includes("severeDisease")) {
    return Number((Math.random() * 2.5 + 4.5).toFixed(1)); // 4.5 ~ 7.0
  }

  if (score <= 2) return Number((Math.random() * 0.9 + 0.4).toFixed(1));   // 0.4 ~ 1.3
  if (score <= 5) return Number((Math.random() * 1.2 + 1.0).toFixed(1));   // 1.0 ~ 2.2
  if (score <= 8) return Number((Math.random() * 1.5 + 1.8).toFixed(1));   // 1.8 ~ 3.3
  if (score <= 12) return Number((Math.random() * 1.8 + 2.8).toFixed(1));  // 2.8 ~ 4.6
  if (score <= 18) return Number((Math.random() * 2.0 + 4.0).toFixed(1));  // 4.0 ~ 6.0

  return Number((Math.random() * 2.0 + 5.5).toFixed(1)); // 5.5 ~ 7.5
}

function getRiskLevel(probability) {
  if (probability < 2) return "low";
  if (probability < 5) return "medium";
  return "high";
}

function getSupportMessage(analysis) {
  if (analysis.hits.includes("selfHarm")) {
    return "你提到了轻生或不想活的念头。先不要一个人扛，尽快联系你信任的人陪你，或联系当地紧急救助与心理支持资源。现在最重要的不是这个概率，而是先让你自己处在有人陪伴和更安全的环境里。";
  }

  if (analysis.hits.includes("criticalEmergency")) {
    return "你输入的是胸痛、呼吸困难、昏厥或大出血这类高危信号。如果这不是玩笑或比喻，请优先考虑尽快联系当地急救或立刻去医院，不要单独硬撑。";
  }

  if (analysis.hits.includes("severeDisease")) {
    return "你提到了严重疾病、住院或手术相关情况。这类内容不适合被轻描淡写对待，今天最重要的是把照顾自己和及时求助放在前面。";
  }

  return "";
}

function sanitizeTitle(title, probability, analysis) {
  let cleaned = String(title || "").trim();

  const banned = [
    "爆款", "热评", "摸鱼", "打工", "朋友圈", "评论区", "整活", "离谱", "抽象"
  ];

  for (const word of banned) {
    cleaned = cleaned.replaceAll(word, "");
  }

  if (analysis.mode === "support") {
    return "先别一个人扛";
  }

  if (analysis.mode === "serious") {
    if (analysis.hits.includes("criticalEmergency")) return "今天要当心";
    if (analysis.hits.includes("severeDisease")) return "状态不轻松";
  }

  if (!cleaned || cleaned.length < 2 || cleaned.includes("分析")) {
    if (probability < 2) {
      cleaned = randomItem(["今天偏稳", "暂时平稳", "今天还行", "整体不高"]);
    } else if (probability < 5) {
      cleaned = randomItem(["稍微留神", "今天一般", "别太大意", "稳着一点"]);
    } else {
      cleaned = randomItem(["今天收着点", "谨慎一点", "状态偏紧", "别硬撑"]);
    }
  }

  if (cleaned.length > 10) cleaned = cleaned.slice(0, 10);
  return cleaned;
}

function buildFallbackReason(userText, analysis) {
  if (!userText.trim()) {
    return "今天没有输入具体事件，所以只能按极低风险的普通状态处理。";
  }

  if (analysis.hits.includes("selfHarm")) {
    return "你提到了轻生或结束生命的念头，这类输入不适合用玩笑处理。今天最重要的不是算得多高，而是尽快让自己处在有人陪伴、可求助的环境里。";
  }

  if (analysis.hits.includes("criticalEmergency")) {
    return "你提到了胸痛、呼吸困难、昏厥或大出血这类高危信号，所以这次结果会明显高于普通日常状态。";
  }

  if (analysis.hits.includes("severeDisease")) {
    return "你提到了严重疾病、住院或手术相关情况，这不是普通小事，因此这次结果会显著高于日常波动。";
  }

  if (analysis.hits.includes("seriousIllness")) {
    return "你提到比较明显的身体异常，这说明今天的状态并不轻松，所以结果会高于最平稳情况。";
  }

  if (analysis.hits.includes("illness") && analysis.hits.includes("sleep")) {
    return "你同时提到了身体不适和睡眠不足，这种组合会让今天的状态更脆弱，因此结果会比普通日常更高。";
  }

  if (analysis.hits.includes("illness")) {
    return "你提到身体有不适，这意味着今天并不是完全正常的一天，所以结果会略高一些。";
  }

  if (analysis.hits.includes("sleep")) {
    return "你提到熬夜或失眠，睡眠不足会影响反应和注意力，因此结果不会按最低水平处理。";
  }

  if (analysis.hits.includes("stress")) {
    return "你提到明显压力或焦虑，精神状态波动会增加失误和状态不稳的可能。";
  }

  return "你给出的信息里有明确的不稳定因素，所以结果会略高于普通平稳状态，但仍保持在克制范围内。";
}

function sanitizeReason(reason, userText, analysis) {
  let cleaned = String(reason || "").trim();

  const bannedPhrases = [
    "用户没有输入",
    "用户没有提供",
    "根据用户输入",
    "根据你的输入",
    "按普通的一天分析",
    "普通平静的一天",
    "随机因子",
    "固定概率",
    "分析过程",
    "JSON",
    "系统提示",
    "根据分析",
    "摸鱼",
    "热评区",
    "朋友圈",
    "爆款文案"
  ];

  bannedPhrases.forEach((p) => {
    cleaned = cleaned.replaceAll(p, "");
  });

  cleaned = cleaned.replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^[，。、“”\s]+|[，。、“”\s]+$/g, "");

  if (!cleaned || cleaned.length < 10) {
    return buildFallbackReason(userText, analysis);
  }

  if (analysis.hits.includes("selfHarm") && !/轻生|不想活|结束生命|陪伴|求助|一个人扛/.test(cleaned)) {
    return buildFallbackReason(userText, analysis);
  }

  if (analysis.hits.includes("severeDisease") && !/疾病|住院|重病|手术|严重/.test(cleaned)) {
    return buildFallbackReason(userText, analysis);
  }

  if (analysis.hits.includes("criticalEmergency") && !/胸痛|呼吸|昏厥|晕倒|出血|心/.test(cleaned)) {
    return buildFallbackReason(userText, analysis);
  }

  if (cleaned.length > 90) {
    cleaned = cleaned.slice(0, 90).trim() + "。";
  }

  return cleaned;
}

function sanitizeTips(tips, probability, analysis) {
  let cleaned = String(tips || "").trim();

  const banned = ["摸鱼", "爆改", "整活", "发朋友圈", "上热评", "冲一波"];
  banned.forEach((word) => {
    cleaned = cleaned.replaceAll(word, "");
  });

  if (analysis.hits.includes("selfHarm")) {
    return "现在先联系一个可信任的人陪你，不要独自扛着。";
  }

  if (analysis.hits.includes("criticalEmergency")) {
    return "如果这是真实情况，请优先尽快就医或联系急救。";
  }

  if (analysis.hits.includes("severeDisease")) {
    return "今天把照顾自己放前面，别硬撑。";
  }

  if (!cleaned || cleaned.length < 2) {
    if (probability < 2) {
      cleaned = randomItem([
        "今天按正常节奏来就行。",
        "整体偏稳，别自己吓自己。",
        "今天的小波动不用过度放大。"
      ]);
    } else if (probability < 5) {
      cleaned = randomItem([
        "今天稍微多留意一下状态。",
        "别太赶，稳一点更合适。",
        "今天适合保守一点处理事情。"
      ]);
    } else {
      cleaned = randomItem([
        "今天尽量减少冒险和硬撑。",
        "先把身体和节奏稳住。",
        "今天更适合谨慎处理。"
      ]);
    }
  }

  if (cleaned.length > 32) cleaned = cleaned.slice(0, 32).trim() + "。";
  return cleaned;
}

function generateFallbackResult(userText, probability, riskLevel, analysis) {
  return {
    probability,
    title: sanitizeTitle("", probability, analysis),
    reason: buildFallbackReason(userText, analysis),
    disclaimer: "仅供娱乐，不构成任何现实预测或建议。",
    riskLevel,
    tips: sanitizeTips("", probability, analysis),
    supportMessage: getSupportMessage(analysis)
  };
}

app.post("/api/check", async (req, res) => {
  const userText = req.body?.text?.trim() || "";
  const hasInput = !!userText;
  const cacheKey = buildCacheKey(userText);
  const ip = getClientIp(req);

  // 1. 相同输入直接返回缓存结果，不计入新的请求生成
  if (responseCache.has(cacheKey)) {
    return res.json(responseCache.get(cacheKey));
  }

  // 2. 每日 5 次限制（只限制“新生成”，缓存命中不算）
  const { key: dailyKey, data: dailyData } = getDailyCounter(ip);
  if (dailyData.count >= DAILY_LIMIT) {
    return res.status(429).json({
      error: "你今天的检测次数已用完，明天再来试试吧。",
      code: "DAILY_LIMIT_EXCEEDED",
      remaining: 0
    });
  }

  const analysis = buildAnalysis(userText);
  const probability = mapScoreToProbability(analysis.score, analysis.hits, hasInput);
  const riskLevel = getRiskLevel(probability);

  const prompt = `
你是一个中文“结果解读”助手，服务于一个娱乐化的今日风险预测页面。

写作风格要求：
1. 普通情况：可以带一点克制的灰色幽默，但不能轻浮，不能像段子。
2. 重大疾病、急性危险信号、轻生念头：禁止灰色幽默，必须温和、认真、鼓励求助。
3. 必须严格根据用户输入解释结果，不要脱离输入瞎发挥。
4. 这是“死亡概率”的娱乐化解读，因此整体概率必须克制，普通事件只能很低，极端事件也不要夸张。
5. 不允许“摸鱼”“爆款”“热评区”“朋友圈”“整活”等词。
6. 不允许修改 probability。

用户输入：
${userText || "无明确事件输入"}

固定概率：
${probability}

风险等级：
${riskLevel}

后端已判断到的关键线索：
${analysis.reasons.join("；")}

当前模式：
${analysis.mode}

输出要求：
- title：4到8个字，像结果标题
- reason：30到85字，必须直接解释“为什么这次概率会这样”，并且必须紧扣用户输入
- tips：12到28字，一句自然提醒
- disclaimer：固定为“仅供娱乐，不构成任何现实预测或建议。”
- supportMessage：
  - 如果检测到轻生念头、严重疾病、胸痛、呼吸困难、昏厥、大出血等，必须输出一段温和的鼓励或求助提醒
  - 普通情况输出空字符串

严格输出 JSON：
{
  "probability": ${probability},
  "title": "短标题",
  "reason": "解释为什么这次概率会这样",
  "disclaimer": "仅供娱乐，不构成任何现实预测或建议。",
  "riskLevel": "${riskLevel}",
  "tips": "一句自然提醒",
  "supportMessage": ""
}
`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);

  try {
    const response = await fetch(process.env.MODEL_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.MODEL_API_KEY}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.MODEL_NAME,
        messages: [{ role: "user", content: prompt }],
        temperature: analysis.mode === "normal" ? 0.6 : 0.35,
        max_tokens: 220
      })
    });

    const data = await response.json();
    clearTimeout(timeout);

    let result;

    if (!response.ok) {
      console.error("Model API error:", data);
      result = generateFallbackResult(userText, probability, riskLevel, analysis);
    } else {
      const content = data.choices?.[0]?.message?.content || "";
      if (!content) {
        throw new Error("模型没有返回内容");
      }

      const parsed = extractJSON(content);

      const finalProbability = clamp(
        Number(parsed.probability) || probability,
        hasInput ? 0.1 : 0.1,
        hasInput ? 9.0 : 0.9
      );

      const finalRiskLevel = getRiskLevel(finalProbability);

      const title = sanitizeTitle(parsed.title, finalProbability, analysis);
      const reason = sanitizeReason(parsed.reason, userText, analysis);
      const tips = sanitizeTips(parsed.tips, finalProbability, analysis);
      const disclaimer = String(
        parsed.disclaimer || "仅供娱乐，不构成任何现实预测或建议。"
      ).trim();

      let supportMessage = String(parsed.supportMessage || "").trim();
      if (!supportMessage && (analysis.mode === "support" || analysis.mode === "serious")) {
        supportMessage = getSupportMessage(analysis);
      }

      result = {
        probability: finalProbability,
        title,
        reason,
        disclaimer,
        riskLevel: finalRiskLevel,
        tips,
        supportMessage
      };
    }

    // 3. 只要是新生成结果，就缓存并计数
    responseCache.set(cacheKey, result);
    dailyData.count += 1;
    dailyRequestStore.set(dailyKey, dailyData);

    return res.json(result);
  } catch (err) {
    clearTimeout(timeout);
    console.error("Server error:", err);

    const result = generateFallbackResult(userText, probability, riskLevel, analysis);

    responseCache.set(cacheKey, result);
    dailyData.count += 1;
    dailyRequestStore.set(dailyKey, dailyData);

    return res.json(result);
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});