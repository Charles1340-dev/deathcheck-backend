require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let lastProbability = null;

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

function scoreRisk(userText) {
  const text = (userText || "").trim();

  if (!text) {
    return {
      score: Math.floor(Math.random() * 5) + 2, // 2~6
      reasons: ["今天像普通模式，没有明显危险加成。"]
    };
  }

  let score = 4;
  const reasons = [];

  const rules = [
    { words: ["熬夜", "通宵", "没睡", "失眠"], add: 8, reason: "睡眠不足会让注意力和反应速度下降" },
    { words: ["感冒", "发烧", "咳嗽", "难受", "生病"], add: 5, reason: "身体状态不稳，今天容易掉线" },
    { words: ["开会", "加班", "赶项目", "压力大", "焦虑", "崩溃"], add: 4, reason: "精神压力会让你今天更容易出小岔子" },
    { words: ["开车", "骑车", "赶路", "赶飞机", "出差"], add: 6, reason: "移动和赶路场景会放大风险" },
    { words: ["喝酒", "醉", "宿醉"], add: 10, reason: "酒精会让今天的稳定性明显下降" },
    { words: ["没吃饭", "低血糖", "很困", "头晕", "头痛"], add: 5, reason: "体力和精神状态不在线" },
    { words: ["在家", "休息", "躺着", "放松", "宅家", "平静"], add: -3, reason: "低活动场景会降低整体风险" },
    { words: ["早睡", "睡得好", "稳定", "正常"], add: -2, reason: "状态比较平稳，今天不容易翻车" }
  ];

  for (const rule of rules) {
    for (const word of rule.words) {
      if (text.includes(word)) {
        score += rule.add;
        reasons.push(rule.reason);
        break;
      }
    }
  }

  const randomOffset = Math.floor(Math.random() * 7) - 3; // -3 ~ +3
  score += randomOffset;

  score = clamp(score, 1, 28);

  return {
    score,
    reasons: reasons.length ? reasons : ["今天没有特别离谱的危险信号，整体算正常波动。"]
  };
}

function mapScoreToProbability(score) {
  // 更贴近“现实感”的概率，不轻易高得离谱
  if (score <= 4) return Math.floor(Math.random() * 5) + 2;       // 2~6
  if (score <= 8) return Math.floor(Math.random() * 6) + 5;       // 5~10
  if (score <= 12) return Math.floor(Math.random() * 7) + 9;      // 9~15
  if (score <= 16) return Math.floor(Math.random() * 8) + 14;     // 14~21
  if (score <= 20) return Math.floor(Math.random() * 8) + 20;     // 20~27
  return Math.floor(Math.random() * 7) + 27;                      // 27~33
}

function ensureDifferentProbability(probability) {
  if (lastProbability === null) return probability;

  let next = probability;
  let count = 0;
  while (next === lastProbability && count < 10) {
    next = clamp(probability + (Math.random() < 0.5 ? -1 : 1), 1, 35);
    count++;
  }
  return next;
}

function getRiskLevel(probability) {
  if (probability <= 12) return "low";
  if (probability <= 24) return "medium";
  return "high";
}

function sanitizeReason(reason, userText) {
  if (!reason) return "";

  let cleaned = String(reason).trim();

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
    "根据分析"
  ];

  bannedPhrases.forEach(p => {
    cleaned = cleaned.replaceAll(p, "");
  });

  cleaned = cleaned.replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^[，。、“”\s]+|[，。、“”\s]+$/g, "");

  if (!userText.trim()) {
    if (!cleaned || cleaned.length < 8) {
      cleaned = randomItem([
        "今天像普通模式，风险不高，属于正常生活波动。",
        "今天整体偏稳，不太像会出大问题的一天。",
        "今天没什么明显危险信号，低调过关的概率更高。"
      ]);
    }
  }

  if (cleaned.length > 60) {
    cleaned = cleaned.slice(0, 60).trim() + "。";
  }

  return cleaned;
}

function sanitizeTitle(title, probability, userText) {
  let cleaned = String(title || "").trim();

  if (!cleaned || cleaned.length < 2 || cleaned.includes("分析")) {
    if (!userText.trim()) {
      cleaned = randomItem([
        "今天问题不大",
        "风平浪静",
        "适合低调过关",
        "今天先别自吓"
      ]);
    } else if (probability <= 12) {
      cleaned = randomItem([
        "今天稳得很",
        "今天别自吓",
        "基本没大事",
        "还算平稳"
      ]);
    } else if (probability <= 24) {
      cleaned = randomItem([
        "今天别太浪",
        "状态有点飘",
        "今天收着点",
        "稳一点比较好"
      ]);
    } else {
      cleaned = randomItem([
        "今天先保守",
        "风险有点高",
        "先别硬撑",
        "今天收着来"
      ]);
    }
  }

  if (cleaned.length > 10) cleaned = cleaned.slice(0, 10);
  return cleaned;
}

function sanitizeTips(tips, probability) {
  let cleaned = String(tips || "").trim();

  if (!cleaned || cleaned.length < 2) {
    if (probability <= 12) {
      cleaned = randomItem([
        "正常发挥就行。",
        "放轻松一点。",
        "低调过关最稳。"
      ]);
    } else if (probability <= 24) {
      cleaned = randomItem([
        "今天别太冒进。",
        "先把节奏放慢。",
        "少做冲动决定。"
      ]);
    } else {
      cleaned = randomItem([
        "今天尽量保守一点。",
        "能歇就先歇会儿。",
        "别硬撑，先稳住。"
      ]);
    }
  }

  if (cleaned.length > 24) cleaned = cleaned.slice(0, 24).trim() + "。";
  return cleaned;
}

app.post("/api/check", async (req, res) => {
  const userText = req.body?.text?.trim() || "";

  const risk = scoreRisk(userText);
  let probability = mapScoreToProbability(risk.score);
  probability = ensureDifferentProbability(probability);

  const riskLevel = getRiskLevel(probability);

  const styleHint =
    riskLevel === "low"
      ? "轻松、好笑、适合发朋友圈，有点摸鱼感"
      : riskLevel === "medium"
      ? "像朋友吐槽你今天状态一般，适合短视频爆款语气"
      : "带点紧张感，但不要恐吓，像热评区一针见血的吐槽";

  const contextHint = userText
    ? `这次风险判断的主要依据：${risk.reasons.join("；")}`
    : "这次没有明确事件输入，按普通日常低风险模式处理。";

  const prompt = `
你是一个很会写“抖音级爆款文案”的中文短文案助手。

用户状态：
${userText || "无"}

固定概率：
${probability}

风险等级：
${riskLevel}

文案风格：
${styleHint}

背景提示：
${contextHint}

任务要求：
1. 不要修改 probability
2. title 要短、抓人、口语化，4到8个字
3. reason 要直接给用户看，18到45字，像朋友吐槽，一眼能懂
4. reason 必须“像结果解读”，不要写成系统分析过程
5. 不要出现“根据输入”“用户没有输入”“普通的一天分析”“固定概率”“JSON”等词
6. tips 要短，10到20字，像一句很顺口的提醒
7. 文案要适合截图分享到朋友圈或短视频评论区
8. 轻微幽默，但不要阴森，不要引导伤害，不要医疗建议
9. 只输出 JSON，不要多余文字

严格输出：
{
  "probability": ${probability},
  "title": "短标题",
  "reason": "自然中文解释",
  "disclaimer": "仅供娱乐，不构成任何现实预测或建议。",
  "riskLevel": "${riskLevel}",
  "tips": "一句顺口提醒"
}
`;

  try {
    const response = await fetch(process.env.MODEL_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.MODEL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.MODEL_NAME,
        messages: [
          { role: "user", content: prompt }
        ],
        temperature: 0.9,
        max_tokens: 300
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Model API error:", data);
      lastProbability = probability;
      return res.status(500).json({
        probability,
        title: sanitizeTitle("", probability, userText),
        reason: userText
          ? randomItem([
              "你今天的状态有点飘，容易在小事上翻车，收着点更稳。",
              "今天精神和节奏不算满格，别把自己逼太紧。",
              "你今天不算危险，但明显不适合硬撑到底。"
            ])
          : randomItem([
              "今天整体偏稳，不太像会出大问题的一天。",
              "今天没什么明显危险信号，低调过关的概率更高。"
            ]),
        disclaimer: "仅供娱乐，不构成任何现实预测或建议。",
        riskLevel,
        tips: sanitizeTips("", probability)
      });
    }

    const content = data.choices?.[0]?.message?.content || "";
    if (!content) {
      throw new Error("模型没有返回内容");
    }

    const parsed = extractJSON(content);

    const finalProbability = clamp(Number(parsed.probability) || probability, 1, 35);
    const finalRiskLevel = getRiskLevel(finalProbability);

    const title = sanitizeTitle(parsed.title, finalProbability, userText);
    const reason = sanitizeReason(parsed.reason, userText);
    const tips = sanitizeTips(parsed.tips, finalProbability);
    const disclaimer = String(
      parsed.disclaimer || "仅供娱乐，不构成任何现实预测或建议。"
    ).trim();

    lastProbability = finalProbability;

    res.json({
      probability: finalProbability,
      title,
      reason,
      disclaimer,
      riskLevel: finalRiskLevel,
      tips
    });
  } catch (err) {
    console.error("Server error:", err);

    lastProbability = probability;

    res.status(500).json({
      probability,
      title: sanitizeTitle("", probability, userText),
      reason: userText
        ? "你今天状态有点微妙，别太浪，稳一点更适合你。"
        : "今天问题不大，属于正常日常波动。",
      disclaimer: "仅供娱乐，不构成任何现实预测或建议。",
      riskLevel,
      tips: sanitizeTips("", probability)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});