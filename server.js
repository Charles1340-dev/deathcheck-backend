require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DAILY_LIMIT = 5;

app.use(cors());
app.use(express.json());

const responseCache = new Map();
const dailyRequestStore = new Map();

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
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
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function getDailyCounter(ip) {
  const key = `${getTodayKey()}:${ip}`;
  if (!dailyRequestStore.has(key)) {
    dailyRequestStore.set(key, { count: 0 });
  }
  return { key, data: dailyRequestStore.get(key) };
}

function normalizeInput(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

function buildAnalysis(userText) {
  const text = normalizeInput(userText);

  if (!text) {
    return {
      mode: "normal",
      hits: [],
      summary: "没有具体事件",
      reasons: ["今天没有输入具体事件，所以只能按普通、低波动的状态处理。"]
    };
  }

  const rules = [
    {
      key: "selfHarm",
      words: ["轻生", "不想活", "想死", "自杀", "结束自己", "结束生命", "活着没意思", "不如死了", "想消失"],
      mode: "support",
      score: 40,
      reason: "你提到了轻生或不想活的念头，这不是适合开玩笑的话题。"
    },
    {
      key: "criticalEmergency",
      words: ["胸痛", "呼吸困难", "喘不过气", "昏厥", "晕倒", "大出血", "心梗", "中风"],
      mode: "serious",
      score: 28,
      reason: "你提到了胸痛、呼吸困难、昏厥或大出血这类高危信号。"
    },
    {
      key: "severeDisease",
      words: ["严重疾病", "重病", "癌", "肿瘤", "恶性", "住院", "急诊", "手术", "化疗", "癌症"],
      mode: "serious",
      score: 20,
      reason: "你提到了严重疾病、住院或手术相关情况。"
    },
    {
      key: "seriousIllness",
      words: ["高烧", "肺炎", "感染严重", "持续发烧", "剧烈头痛", "剧烈腹痛"],
      mode: "normal",
      score: 12,
      reason: "你提到比较明显的身体异常，今天状态不会太轻松。"
    },
    {
      key: "illness",
      words: ["感冒", "发烧", "生病", "咳嗽", "头晕", "头痛", "难受", "不舒服", "皮质醇过高"],
      mode: "normal",
      score: 5,
      reason: "你提到了身体不适，说明今天不是满状态运行。"
    },
    {
      key: "sleep",
      words: ["熬夜", "通宵", "没睡", "失眠", "只睡", "凌晨三点", "凌晨4点", "凌晨5点"],
      mode: "normal",
      score: 4,
      reason: "你提到睡眠不足，今天的反应和精神状态会受影响。"
    },
    {
      key: "stress",
      words: ["焦虑", "压力大", "崩溃", "烦", "精神紧张", "情绪差", "高压"],
      mode: "normal",
      score: 3,
      reason: "你提到压力或情绪波动，今天更容易状态起伏。"
    },
    {
      key: "traffic",
      words: ["开车", "骑车", "赶路", "赶飞机", "出差", "高速", "长途"],
      mode: "normal",
      score: 3,
      reason: "今天如果还要赶路或长时间移动，风险会再抬一点。"
    },
    {
      key: "alcohol",
      words: ["喝酒", "醉", "宿醉", "酒后"],
      mode: "normal",
      score: 5,
      reason: "酒精或宿醉会让身体状态和判断更不稳定。"
    },
    {
      key: "foodEnergy",
      words: ["没吃饭", "低血糖", "很饿", "体力差", "乏力"],
      mode: "normal",
      score: 3,
      reason: "体力和能量不足时，今天更容易掉线。"
    },
    {
      key: "rest",
      words: ["休息", "在家", "躺着", "卧床", "不出门"],
      mode: "normal",
      score: -2,
      reason: "低活动场景会稍微压低外部风险。"
    },
    {
      key: "stable",
      words: ["睡得好", "稳定", "正常", "状态不错", "精神不错", "今天挺好"],
      mode: "normal",
      score: -2,
      reason: "你提到整体状态尚可，所以不会往高处走。"
    }
  ];

  let score = 0;
  let mode = "normal";
  const hits = [];
  const reasons = [];

  for (const rule of rules) {
    if (includesAny(text, rule.words)) {
      hits.push(rule.key);
      reasons.push(rule.reason);
      score += rule.score;

      if (rule.mode === "support") mode = "support";
      else if (rule.mode === "serious" && mode !== "support") mode = "serious";
    }
  }

  if (score < 0) score = 0;

  return {
    mode,
    hits,
    score,
    summary: reasons[0] || "普通日常状态",
    reasons: reasons.length ? reasons : ["没有明显高危线索，更接近日常普通波动。"]
  };
}

function probabilityFromAnalysis(analysis, hasInput) {
  if (!hasInput) {
    return Number((Math.random() * 0.7 + 0.1).toFixed(1)); // 0.1~0.8
  }

  if (analysis.hits.includes("selfHarm")) {
    return Number((Math.random() * 2 + 7).toFixed(1)); // 7.0~9.0
  }

  if (analysis.hits.includes("criticalEmergency")) {
    return Number((Math.random() * 3 + 6).toFixed(1)); // 6.0~9.0
  }

  if (analysis.hits.includes("severeDisease")) {
    return Number((Math.random() * 2.5 + 4.5).toFixed(1)); // 4.5~7.0
  }

  const score = analysis.score;

  if (score <= 2) return Number((Math.random() * 0.9 + 0.4).toFixed(1));   // 0.4~1.3
  if (score <= 5) return Number((Math.random() * 1.2 + 1.0).toFixed(1));   // 1.0~2.2
  if (score <= 8) return Number((Math.random() * 1.5 + 1.8).toFixed(1));   // 1.8~3.3
  if (score <= 12) return Number((Math.random() * 1.8 + 2.8).toFixed(1));  // 2.8~4.6
  if (score <= 18) return Number((Math.random() * 2 + 4).toFixed(1));      // 4.0~6.0

  return Number((Math.random() * 2 + 5.5).toFixed(1));                      // 5.5~7.5
}

function getRiskLevel(probability) {
  if (probability < 2) return "low";
  if (probability < 5) return "medium";
  return "high";
}

function getSupportMessage(analysis) {
  if (analysis.hits.includes("selfHarm")) {
    return "你提到了轻生或不想活的念头。先别一个人扛，尽快联系你信任的人陪你，或者联系当地紧急救助与心理支持资源。现在最重要的不是这个数字，而是先让自己处在更安全、有人陪伴的环境里。";
  }

  if (analysis.hits.includes("criticalEmergency")) {
    return "你提到的是胸痛、呼吸困难、昏厥或大出血这类高危信号。如果这是真实情况，请优先考虑尽快就医或联系当地急救，不要独自硬撑。";
  }

  if (analysis.hits.includes("severeDisease")) {
    return "你提到了严重疾病、住院或手术相关情况。今天最重要的不是这个结果本身，而是先把照顾自己和及时求助放在前面。";
  }

  return "";
}

function humanTitle(probability, analysis) {
  if (analysis.mode === "support") return "先别一个人扛";
  if (analysis.mode === "serious") {
    if (analysis.hits.includes("criticalEmergency")) return "今天要当心";
    if (analysis.hits.includes("severeDisease")) return "状态不轻松";
  }

  if (probability < 1) return randomItem(["今天偏稳", "没啥波澜", "暂时平稳", "今天还行"]);
  if (probability < 2.5) return randomItem(["稍微留神", "今天一般", "别太大意", "稳着一点"]);
  if (probability < 5) return randomItem(["今天收着点", "别太硬撑", "状态一般", "多留点神"]);
  return randomItem(["今天要当心", "状态偏紧", "谨慎一点", "先稳住"]);
}

function humanReason(userText, analysis, probability) {
  const text = normalizeInput(userText);

  if (!text) {
    return randomItem([
      "今天没发生什么特别的事，那就按普通的一天来算，波动不大，风险也自然压得很低。",
      "没给出具体事件的时候，只能把今天当成最普通的日常，没什么特别值得拉高的地方。",
      "今天没有明显异常信息，所以这次结果就停在很低的位置，不往高处吓人。"
    ]);
  }

  if (analysis.hits.includes("selfHarm")) {
    return "你提到的已经不是普通情绪波动了，所以这次不会用玩笑口吻带过去。现在更重要的是先把自己照顾好，并尽快找人陪着你。";
  }

  if (analysis.hits.includes("criticalEmergency")) {
    return "你提到的是胸痛、呼吸困难、昏厥或大出血这种高危信号，这种情况当然不能按普通不舒服来算，所以这次结果会明显高于日常。";
  }

  if (analysis.hits.includes("severeDisease")) {
    return "你提到了严重疾病、住院或手术相关情况，这已经不是普通小波动，所以这次结果会比平常高一些，但还是保持在克制范围里。";
  }

  if (analysis.hits.includes("seriousIllness")) {
    return "你今天的状态明显不在舒适区，所以这次结果不会按最低档走，但也不会故意夸张到吓人。";
  }

  if (analysis.hits.includes("illness") && analysis.hits.includes("sleep")) {
    return "身体不舒服再叠上睡眠不足，今天整个人就容易发虚，所以这次结果会比普通日常再往上抬一点。";
  }

  if (analysis.hits.includes("sleep") && analysis.hits.includes("traffic")) {
    return "睡得不够还要赶路，这种组合就像人还没醒，生活已经开始催你了，所以结果不会太低。";
  }

  if (analysis.hits.includes("illness")) {
    return "身体已经有点不对劲了，今天自然不算满血状态，所以这次结果会比完全正常的时候高一点。";
  }

  if (analysis.hits.includes("sleep")) {
    return "你提到熬夜或没睡好，今天脑子和身体大概率都不在巅峰，所以结果会稍微往上走一点。";
  }

  if (analysis.hits.includes("stress")) {
    return "压力这东西不一定立刻出事，但会让人更容易判断失误，所以这次结果会比平静状态稍微高一些。";
  }

  if (analysis.hits.includes("traffic")) {
    return "今天如果还要开车、赶路或者长时间在外面跑，风险就不会像在家躺着那样低。";
  }

  return "你这次输入里有一点不稳定因素，但还没到夸张的程度，所以结果只是轻轻往上抬了一点。";
}

function humanAdvice(analysis, probability) {
  if (analysis.hits.includes("selfHarm")) {
    return "现在先联系一个你信得过的人，别让自己一个人扛着。";
  }

  if (analysis.hits.includes("criticalEmergency")) {
    return "如果这是真实情况，请优先考虑尽快就医或联系急救。";
  }

  if (analysis.hits.includes("severeDisease")) {
    return "今天把照顾自己放前面，别硬撑，也别逞强。";
  }

  if (probability < 1) {
    return randomItem([
      "今天正常过就行，不用自己吓自己。",
      "这一天看着还算平稳，按平常节奏来就好。",
      "今天不用上强度，稳稳过完就行。"
    ]);
  }

  if (probability < 2.5) {
    return randomItem([
      "今天多留意一下状态，别把小问题拖大。",
      "节奏放缓一点，今天更适合稳着来。",
      "别太赶，先把自己顾好再说。"
    ]);
  }

  if (probability < 5) {
    return randomItem([
      "今天少一点硬撑，多一点留神。",
      "能慢一点就慢一点，别把自己逼太紧。",
      "今天更适合保守一点处理事情。"
    ]);
  }

  return randomItem([
    "今天尽量把节奏降下来，先稳住最重要。",
    "别逞强，先让自己处在更安全的状态里。",
    "今天先照顾好自己，别硬顶。"
  ]);
}

function buildResult(userText, probability, analysis) {
  return {
    probability,
    title: humanTitle(probability, analysis),
    reason: humanReason(userText, analysis, probability),
    disclaimer: "仅供娱乐，不构成任何现实预测或建议。",
    riskLevel: getRiskLevel(probability),
    tips: humanAdvice(analysis, probability),
    supportMessage: getSupportMessage(analysis)
  };
}

app.post("/api/check", async (req, res) => {
  const userText = normalizeInput(req.body?.text || "");
  const hasInput = !!userText;
  const cacheKey = hashText(userText);
  const ip = getClientIp(req);

  // 命中缓存：直接返回，不占次数
  if (responseCache.has(cacheKey)) {
    return res.json(responseCache.get(cacheKey));
  }

  const { key: dailyKey, data: dailyData } = getDailyCounter(ip);
  if (dailyData.count >= DAILY_LIMIT) {
    return res.status(429).json({
      error: "你今天的检测次数已经用完了，明天再来吧。",
      code: "DAILY_LIMIT_EXCEEDED",
      remaining: 0
    });
  }

  const analysis = buildAnalysis(userText);
  const probability = probabilityFromAnalysis(analysis, hasInput);
  const result = buildResult(userText, probability, analysis);

  responseCache.set(cacheKey, result);
  dailyData.count += 1;
  dailyRequestStore.set(dailyKey, dailyData);

  return res.json(result);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});