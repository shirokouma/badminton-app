import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db } from "./firebase";
import "./styles.css";

function shuffle(array) {
  const copied = [...array];
  for (let i = copied.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copied[i], copied[j]] = [copied[j], copied[i]];
  }
  return copied;
}

function pairKey(a, b) {
  return [a.id, b.id].sort().join("-");
}

function getAllPairs(members) {
  const pairs = [];

  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      pairs.push(pairKey(members[i], members[j]));
    }
  }

  return pairs;
}

function groupKey(members) {
  return members.map((member) => member.id).sort().join("-");
}

function makeBestGame(
  waitingMembers,
  pairHistory,
  opponentHistory,
  relationshipHistory,
  courtGroupHistory,
  playCounts,
  playCountSpreadLimit = 2
) {
  if (waitingMembers.length < 4) return null;

  const sortedByPlayCount = shuffle(waitingMembers).sort(
    (a, b) => (playCounts[a.id] || 0) - (playCounts[b.id] || 0)
  );

  const zeroPlayMembers = sortedByPlayCount.filter(
    (member) => (playCounts[member.id] || 0) === 0
  );

  const mustZeroCount = Math.min(4, zeroPlayMembers.length);
  const candidateMap = new Map();

  zeroPlayMembers.forEach((member) => candidateMap.set(member.id, member));
  sortedByPlayCount
    .slice(0, Math.min(16, sortedByPlayCount.length))
    .forEach((member) => candidateMap.set(member.id, member));

  const candidates = Array.from(candidateMap.values());

  const lowestPlayCount = Math.min(
    ...waitingMembers.map((member) => playCounts[member.id] || 0)
  );

  let best = null;

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      for (let k = j + 1; k < candidates.length; k++) {
        for (let l = k + 1; l < candidates.length; l++) {
          const group = [
            candidates[i],
            candidates[j],
            candidates[k],
            candidates[l],
          ];

          // レート均等ペア1：4人を選んだあと、強さの偏りが少ないペア分けを優先する
          // rateRankedGroup[0] が一番強く、rateRankedGroup[3] が一番弱い
          const rateRankedGroup = [...group].sort(
            (a, b) => getMemberRate(b) - getMemberRate(a)
          );

          const patterns = [
            // 1・4 vs 2・3：基本的に最もバランスが取りやすい
            [
              [0, 3],
              [1, 2],
            ],
            // 1・3 vs 2・4：次にバランスが取りやすい
            [
              [0, 2],
              [1, 3],
            ],
            // 1・2 vs 3・4：レート差が小さい場合のみ自然に採用される
            [
              [0, 1],
              [2, 3],
            ],
          ];

          for (const pattern of patterns) {
            const teamA = [
              rateRankedGroup[pattern[0][0]],
              rateRankedGroup[pattern[0][1]],
            ];
            const teamB = [
              rateRankedGroup[pattern[1][0]],
              rateRankedGroup[pattern[1][1]],
            ];

            const keyA = pairKey(teamA[0], teamA[1]);
            const keyB = pairKey(teamB[0], teamB[1]);
            const currentGroupKey = groupKey(group);

            const groupPlayCounts = group.map(
              (member) => playCounts[member.id] || 0
            );
            const groupMaxPlayCount = Math.max(...groupPlayCounts);
            const groupMinPlayCount = Math.min(...groupPlayCounts);

            const groupZeroCount = group.filter(
              (member) => (playCounts[member.id] || 0) === 0
            ).length;

            const zeroPlayPenalty = Math.max(
              0,
              mustZeroCount - groupZeroCount
            );

            const lowPlayPriorityPenalty = group.reduce((sum, member) => {
              return (
                sum +
                Math.max(0, (playCounts[member.id] || 0) - lowestPlayCount)
              );
            }, 0);

            const normalizedPlayCountSpreadLimit =
              playCountSpreadLimit === "none" ? 999 : Number(playCountSpreadLimit) || 2;

            const playCountSpreadPenalty = Math.max(
              0,
              groupMaxPlayCount - groupMinPlayCount - normalizedPlayCountSpreadLimit
            );

            const allCourtPairs = getAllPairs(group);

            const relationshipPenalty = allCourtPairs.reduce(
              (sum, key) => sum + (relationshipHistory[key] || 0),
              0
            );

            const courtGroupPenalty = courtGroupHistory[currentGroupKey] || 0;

            const pairDuplicatePenalty =
              (pairHistory[keyA] || 0) + (pairHistory[keyB] || 0);

            const opponentPairs = [
              pairKey(teamA[0], teamB[0]),
              pairKey(teamA[0], teamB[1]),
              pairKey(teamA[1], teamB[0]),
              pairKey(teamA[1], teamB[1]),
            ];

            const opponentPenalty = opponentPairs.reduce(
              (sum, key) => sum + (opponentHistory[key] || 0),
              0
            );

            const teamARate = teamA.reduce(
              (sum, member) => sum + getMemberRate(member),
              0
            );
            const teamBRate = teamB.reduce(
              (sum, member) => sum + getMemberRate(member),
              0
            );
            const rateDiffPenalty = Math.abs(teamARate - teamBRate);

            const rateBalancePenalty = rateDiffPenalty * 50;

            const score =
              zeroPlayPenalty * 10000000 +
              lowPlayPriorityPenalty * 1000000 +
              playCountSpreadPenalty * 500000 +
              courtGroupPenalty * 300000 +
              relationshipPenalty * 80000 +
              rateBalancePenalty +
              pairDuplicatePenalty * 10000 +
              opponentPenalty * 5000 +
              Math.random();

            if (!best || score < best.score) {
              best = {
                teamA,
                teamB,
                pairKeys: [keyA, keyB],
                opponentKeys: opponentPairs,
                relationshipKeys: allCourtPairs,
                courtGroupKey: currentGroupKey,
                score,
              };
            }
          }
        }
      }
    }
  }

  return best;
}

const groupNameOptions = [
  "初級",
  "中級",
  "中上級",
  "上級",
  "グループ1",
  "グループ2",
  "グループ3",
  "グループ4",
  "グループ5",
  "グループ6",
  "グループ7",
  "グループ8",
];

const genderOptions = ["男", "女", "なし"];
const rateDisplayOptions = ["なし", "あり"];
const playCountSpreadOptions = [
  { label: "1回まで", value: 1, note: "かなり公平" },
  { label: "2回まで", value: 2, note: "標準" },
  { label: "3回まで", value: 3, note: "交流優先" },
  { label: "気にしない", value: "none", note: "レート・ペア重複優先" },
];

const rankOptions = [
  "バドミントンのルール知らない",
  "初心者",
  "基礎打ちができる",
  "ゲーム中打ち分けが出来る",
  "得意技がある",
  "中級（大会4、5部参加したことがある）",
  "上級（大会4、5部で優勝したことがある、3部に参加したことがある）",
  "大会で1部2部で出たことがある",
  "大会では1部の常連",
  "全国経験あり",
];

const rankRateMap = {
  バドミントンのルール知らない: 2000,
  初心者: 2300,
  基礎打ちができる: 2600,
  ゲーム中打ち分けが出来る: 2900,
  得意技がある: 3100,
  "中級（大会4、5部参加したことがある）": 3300,
  "上級（大会4、5部で優勝したことがある、3部に参加したことがある）": 3500,
  大会で1部2部で出たことがある: 3700,
  大会では1部の常連: 3900,
  全国経験あり: 4100,
};

const DEFAULT_RATE_CHANGE_BASE = 60;

const DEFAULT_RANK_INITIAL_RATES = { ...rankRateMap };

const DEFAULT_RATE_PROFILES = ["通常", "初級", "中級", "上級"];

const CREATE_CIRCLE_KEY = "232355";

const kanaJumpGroups = [
  { key: "あ", label: "あ", chars: ["あ", "い", "う", "え", "お"] },
  { key: "か", label: "か", chars: ["か", "き", "く", "け", "こ", "が", "ぎ", "ぐ", "げ", "ご"] },
  { key: "さ", label: "さ", chars: ["さ", "し", "す", "せ", "そ", "ざ", "じ", "ず", "ぜ", "ぞ"] },
  { key: "た", label: "た", chars: ["た", "ち", "つ", "て", "と", "だ", "ぢ", "づ", "で", "ど"] },
  { key: "な", label: "な", chars: ["な", "に", "ぬ", "ね", "の"] },
  { key: "は", label: "は", chars: ["は", "ひ", "ふ", "へ", "ほ", "ば", "び", "ぶ", "べ", "ぼ", "ぱ", "ぴ", "ぷ", "ぺ", "ぽ"] },
  { key: "ま", label: "ま", chars: ["ま", "み", "む", "め", "も"] },
  { key: "や", label: "や", chars: ["や", "ゆ", "よ"] },
  { key: "ら", label: "ら", chars: ["ら", "り", "る", "れ", "ろ"] },
  { key: "わ", label: "わ", chars: ["わ", "を", "ん"] },
  { key: "英", label: "英", chars: [] },
  { key: "数", label: "数", chars: [] },
  { key: "他", label: "他", chars: [] },
];

function getKanaJumpGroupKey(member) {
  const text = (member.reading || member.nickname || member.name || "").trim();
  const first = text.charAt(0).toLowerCase();

  if (!first) return "他";

  if (/^[a-z]$/.test(first)) return "英";
  if (/^[0-9]$/.test(first)) return "数";

  const group = kanaJumpGroups.find((item) => item.chars.includes(first));
  return group?.key || "他";
}


function getInitialRate(rank) {
  return rankRateMap[rank] || 3000;
}

function getMemberRate(member) {
  if (typeof member.rate === "number") return member.rate;
  return getInitialRate(member.rank);
}

function clampRateMove(value) {
  return Math.max(0, Math.min(180, value));
}

function calculateRateMove(winnerTeam, loserTeam) {
  const winnerTotal = winnerTeam.reduce(
    (sum, member) => sum + getMemberRate(member),
    0
  );

  const loserTotal = loserTeam.reduce(
    (sum, member) => sum + getMemberRate(member),
    0
  );

  const diff = Math.abs(winnerTotal - loserTotal);
  const bonus = Math.floor(diff / 25);

  let move = 60;

  if (winnerTotal < loserTotal) {
    move = 60 + bonus;
  }

  if (winnerTotal > loserTotal) {
    move = 60 - bonus;
  }

  return clampRateMove(move);
}

function applyRateToMember(member, change) {
  return {
    ...member,
    rate: getMemberRate(member) + change,
  };
}

function normalizeCircleId(value) {
  return value.trim().toLowerCase();
}

function getCircledNumber(number) {
  const circledNumbers = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];
  return circledNumbers[number - 1] || String(number);
}
const layoutOptions = {
  1: [{ id: "one", columns: 1, cells: [1] }],
  2: [
    { id: "two-horizontal", columns: 2, cells: [1, 2] },
    { id: "two-vertical", columns: 1, cells: [1, 2] },
  ],
  3: [
    { id: "three-horizontal", columns: 3, cells: [1, 2, 3] },
    { id: "three-left", columns: 2, cells: [1, 2, 3, null] },
    { id: "three-right", columns: 2, cells: [1, 2, null, 3] },
  ],
  4: [
    { id: "four-horizontal", columns: 4, cells: [1, 2, 3, 4] },
    { id: "four-square", columns: 2, cells: [1, 2, 3, 4] },
    { id: "four-left", columns: 3, cells: [1, 2, 3, 4, null, null] },
    { id: "four-right", columns: 3, cells: [1, 2, 3, null, null, 4] },
    { id: "four-center", columns: 3, cells: [1, 2, 3, null, 4, null] },
  ],
  5: [
    { id: "five-horizontal", columns: 5, cells: [1, 2, 3, 4, 5] },
    {
      id: "five-left",
      columns: 4,
      cells: [1, 2, 3, 4, 5, null, null, null],
    },
    {
      id: "five-right",
      columns: 4,
      cells: [1, 2, 3, 4, null, null, null, 5],
    },
    { id: "five-3-2", columns: 3, cells: [1, 2, 3, 4, 5, null] },
    { id: "five-2-3", columns: 3, cells: [1, 2, null, 3, 4, 5] },
    { id: "five-u", columns: 3, cells: [1, 2, 3, 4, null, 5] },
  ],
  6: [
    { id: "six-3-2", columns: 3, cells: [1, 2, 3, 4, 5, 6] },
    {
      id: "six-left",
      columns: 4,
      cells: [1, 2, 3, 4, 5, 6, null, null],
    },
    {
      id: "six-right",
      columns: 4,
      cells: [1, 2, 3, 4, null, null, 5, 6],
    },
    {
      id: "six-center",
      columns: 4,
      cells: [1, 2, 3, 4, null, 5, 6, null],
    },
  ],
  7: [
    {
      id: "seven-left",
      columns: 4,
      cells: [1, 2, 3, 4, 5, 6, 7, null],
    },
    {
      id: "seven-right",
      columns: 4,
      cells: [1, 2, 3, 4, null, 5, 6, 7],
    },
  ],
  8: [{ id: "eight", columns: 4, cells: [1, 2, 3, 4, 5, 6, 7, 8] }],
};

function rotateLayout(layout) {
  if (!layout) return null;

  const rows = Math.ceil(layout.cells.length / layout.columns);
  const matrix = [];

  for (let r = 0; r < rows; r++) {
    matrix.push(layout.cells.slice(r * layout.columns, (r + 1) * layout.columns));
  }

  const rotatedCells = [];

  for (let c = 0; c < layout.columns; c++) {
    for (let r = rows - 1; r >= 0; r--) {
      rotatedCells.push(matrix[r][c] ?? null);
    }
  }

  return {
    ...layout,
    columns: rows,
    cells: rotatedCells,
  };
}

function hasThreeOrMoreHorizontalCourts(layout) {
  if (!layout) return false;

  for (let i = 0; i < layout.cells.length; i += layout.columns) {
    const row = layout.cells.slice(i, i + layout.columns);
    let count = 0;

    for (const cell of row) {
      if (cell) {
        count += 1;
        if (count >= 3) return true;
      } else {
        count = 0;
      }
    }
  }

  return false;
}

function MiniCourt() {
  return <div className="miniCourt" />;
}

function MiniLayout({ layout }) {
  return (
    <div
      className="miniLayout"
      style={{ gridTemplateColumns: `repeat(${layout.columns}, 34px)` }}
    >
      {layout.cells.map((cell, index) =>
        cell ? <MiniCourt key={index} /> : <div key={index} className="miniBlank" />
      )}
    </div>
  );
}

const emptyMemberForm = {
  nickname: "",
  reading: "",
  gender: "",
  rank: "",
};

function getPointRuleMinutes(pointRule) {
  if (pointRule === "11点") return 15;
  if (pointRule === "15点") return 20;
  return 25;
}

function createGroupObject({
  groupName,
  courtCount,
  layoutId,
  rateDisplay,
  playCountVisible,
  pointRule,
  playCountSpreadLimit = 2,
}) {
  return {
    id: Date.now().toString(),
    groupName,
    courtCount,
    layoutId,
    rateDisplay,
    playCountVisible,
    pointRule,
    playCountSpreadLimit,
    createdAt: Date.now(),
    waitingMembers: [],
    courts: Array.from({ length: Number(courtCount) }, () => null),
    pairHistory: {},
    opponentHistory: {},
    relationshipHistory: {},
    courtGroupHistory: {},
    playCounts: {},
    selectedSwap: null,
  };
}

function getInitialPlayCountForGroup(group) {
  if (!group?.createdAt) return 0;

  const elapsed = Date.now() - group.createdAt;
  const minutes = getPointRuleMinutes(group.pointRule);
  const interval = minutes * 60 * 1000;

  return Math.floor(elapsed / interval);
}

function getPracticeDateKey(date = new Date()) {
  const target = new Date(date);

  // 練習日切替1：午前4時までは前日の練習扱いにする
  if (target.getHours() < 4) {
    target.setDate(target.getDate() - 1);
  }

  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, "0");
  const day = String(target.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getViewerCircleIdFromUrl() {
  if (typeof window === "undefined") return "";

  const params = new URLSearchParams(window.location.search);
  const queryCircleId = params.get("viewerCircle") || params.get("viewCircle");

  if (queryCircleId) return normalizeCircleId(queryCircleId);

  const pathMatch = window.location.pathname.match(/\/view\/([^/]+)/);
  if (pathMatch?.[1]) {
    return normalizeCircleId(decodeURIComponent(pathMatch[1]));
  }

  return "";
}

function buildViewerUrl(circleId) {
  if (typeof window === "undefined" || !circleId) return "";

  return `${window.location.origin}/?viewerCircle=${encodeURIComponent(circleId)}`;
}

function buildQrCodeUrl(text) {
  if (!text) return "";

  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(text)}`;
}

// 端末自動識別1：手入力なしで大まかな端末種別を判定する
function detectDeviceType() {
  if (typeof navigator === "undefined") return "不明";

  const userAgent = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const maxTouchPoints = navigator.maxTouchPoints || 0;

  // iPadOS 13以降はMacとして見えることがあるため先に判定する
  if (/iPad/i.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1)) {
    return "iPad";
  }

  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/Android/i.test(userAgent)) return "Android";
  if (/Windows/i.test(userAgent) || /^Win/i.test(platform)) return "Windows PC";
  if (/Macintosh|Mac OS X/i.test(userAgent) || /^Mac/i.test(platform)) return "Mac";

  return "不明";
}

// 読み方自動入力1：カタカナをひらがなへ正規化する
function katakanaToHiragana(value = "") {
  return String(value).replace(/[ァ-ヶ]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0x60)
  );
}

// 読み方欄は「ひらがな・英字・数字・長音・空白」のみ保持する。
// 漢字や記号は読み方欄には残さない。
function normalizeReadingInput(value = "") {
  return katakanaToHiragana(value)
    .replace(/[^ぁ-ゖゝゞーa-zA-Z0-9\s]/g, "")
    .replace(/\s+/g, " ");
}

function containsKanji(value = "") {
  return /[一-龯々〆ヵヶ]/.test(String(value));
}

// 外部APIや個人情報の送信を使わずに動かすため、よく使われる名字だけ
// 安全なローカル候補として持つ。候補にない漢字名は読み方を空欄のままにし、本人確認を優先する。
const COMMON_NAME_READING_MAP = {
  "佐藤": "さとう", "鈴木": "すずき", "高橋": "たかはし", "田中": "たなか",
  "伊藤": "いとう", "渡辺": "わたなべ", "山本": "やまもと", "中村": "なかむら",
  "小林": "こばやし", "加藤": "かとう", "吉田": "よしだ", "山田": "やまだ",
  "佐々木": "ささき", "山口": "やまぐち", "松本": "まつもと", "井上": "いのうえ",
  "木村": "きむら", "林": "はやし", "斎藤": "さいとう", "齋藤": "さいとう",
  "清水": "しみず", "山崎": "やまざき", "森": "もり", "阿部": "あべ",
  "池田": "いけだ", "橋本": "はしもと", "山下": "やました", "石川": "いしかわ",
  "中島": "なかじま", "前田": "まえだ", "藤田": "ふじた", "小川": "おがわ",
  "後藤": "ごとう", "岡田": "おかだ", "長谷川": "はせがわ", "村上": "むらかみ",
  "近藤": "こんどう", "石井": "いしい", "坂本": "さかもと", "遠藤": "えんどう",
  "青木": "あおき", "藤井": "ふじい", "西村": "にしむら", "福田": "ふくだ",
  "太田": "おおた", "三浦": "みうら", "藤原": "ふじわら", "岡本": "おかもと",
  "松田": "まつだ", "中川": "なかがわ", "中野": "なかの", "原田": "はらだ",
  "小野": "おの", "田村": "たむら", "竹内": "たけうち", "金子": "かねこ",
  "和田": "わだ", "中山": "なかやま", "石田": "いしだ", "上田": "うえだ",
  "森田": "もりた", "原": "はら", "柴田": "しばた", "酒井": "さかい",
  "工藤": "くどう", "横山": "よこやま", "宮崎": "みやざき", "宮本": "みやもと",
  "内田": "うちだ", "高木": "たかぎ", "安藤": "あんどう", "谷口": "たにぐち",
  "大野": "おおの", "丸山": "まるやま", "今井": "いまい", "河野": "こうの",
  "藤本": "ふじもと", "村田": "むらた", "武田": "たけだ", "上野": "うえの",
  "杉山": "すぎやま", "増田": "ますだ", "小島": "こじま", "小山": "こやま",
  "大塚": "おおつか", "平野": "ひらの", "菅原": "すがわら", "久保": "くぼ",
  "松井": "まつい", "千葉": "ちば", "岩崎": "いわさき", "桜井": "さくらい",
  "木下": "きのした", "野口": "のぐち", "松尾": "まつお", "野村": "のむら",
  "新井": "あらい", "渡部": "わたべ", "佐野": "さの", "杉本": "すぎもと",
  "市川": "いちかわ"
};

function getSuggestedReadingFromNickname(nickname = "") {
  const trimmed = String(nickname).trim();
  if (!trimmed) return "";

  if (!containsKanji(trimmed)) {
    return normalizeReadingInput(trimmed);
  }

  return COMMON_NAME_READING_MAP[trimmed] || "";
}

function updateFormNicknameWithAutoReading(form, setForm, nextNickname) {
  const previousSuggested = getSuggestedReadingFromNickname(form.nickname || "");
  const currentReading = form.reading || "";
  const canAutoReplace =
    !currentReading.trim() ||
    currentReading === previousSuggested ||
    currentReading === normalizeReadingInput(form.nickname || "");

  const nextSuggested = getSuggestedReadingFromNickname(nextNickname);

  setForm({
    ...form,
    nickname: nextNickname,
    reading: canAutoReplace && nextSuggested ? nextSuggested : currentReading,
  });
}

function hashText(value = "") {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function createCourtGameId(groupId, courtIndex) {
  return `game-${groupId}-${courtIndex}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

function getStableCourtGameId(groupId, courtIndex, court) {
  if (court?.gameId) return court.gameId;

  const memberIds = court
    ? [...(court.teamA || []), ...(court.teamB || [])]
        .map((member) => member.id)
        .sort()
        .join("-")
    : "empty";

  const legacySeed = `${groupId}|${courtIndex}|${memberIds}|${court?.score ?? ""}`;
  return `legacy-${hashText(legacySeed)}`;
}

function formatOperationTime(value) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function App() {
  const [authMode, setAuthMode] = useState("login");
  const [currentCircle, setCurrentCircle] = useState(null);
  const [userMode, setUserMode] = useState("normal");
  const [viewerStep, setViewerStep] = useState("none");
  const [viewerMemberForm, setViewerMemberForm] = useState(emptyMemberForm);
  const [viewerMemberFormError, setViewerMemberFormError] = useState(false);
  const [viewerDuplicateNicknameError, setViewerDuplicateNicknameError] = useState("");
  const [viewerSelectedMemberId, setViewerSelectedMemberId] = useState("");
  const [isViewerGuideOpen, setIsViewerGuideOpen] = useState(false);
  const [viewerMemberSearch, setViewerMemberSearch] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [memberLoading, setMemberLoading] = useState(false);

  const [loginForm, setLoginForm] = useState({
    circleId: "",
    password: "",
  });

  const [createCircleForm, setCreateCircleForm] = useState({
    circleName: "",
    circleId: "",
    password: "",
    masterPassword: "",
    viewerPassword: "",
    createKey: "",
  });

  const [screen, setScreen] = useState("home");
  const [members, setMembers] = useState([]);

  const [groups, setGroups] = useState([]);
  const [activeGroupId, setActiveGroupId] = useState(null);

  const [createGroupName, setCreateGroupName] = useState("");
  const [createCourtCount, setCreateCourtCount] = useState("");
  const [createLayoutId, setCreateLayoutId] = useState("");
  const [createRateDisplay, setCreateRateDisplay] = useState("");
  const [createPlayCountVisible, setCreatePlayCountVisible] = useState("");
  const [createPointRule, setCreatePointRule] = useState("");
  const [createPlayCountSpreadLimit, setCreatePlayCountSpreadLimit] = useState("");
  const [groupError, setGroupError] = useState(false);

  const [layoutChangeMode, setLayoutChangeMode] = useState(null);
  const [pendingCourtCount, setPendingCourtCount] = useState("");

  const [isParticipationModalOpen, setIsParticipationModalOpen] = useState(false);
  const [tempSelectedIds, setTempSelectedIds] = useState([]);
  const [participationError, setParticipationError] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [isNewMemberFormOpen, setIsNewMemberFormOpen] = useState(false);
  const [isImportMemberModalOpen, setIsImportMemberModalOpen] = useState(false);
  const [importCircleForm, setImportCircleForm] = useState({
    circleId: "",
    password: "",
  });
  const [importMembers, setImportMembers] = useState([]);
  const [importSelectedIds, setImportSelectedIds] = useState([]);
  const [importError, setImportError] = useState("");
  const [importLoading, setImportLoading] = useState(false);
  const [memberForm, setMemberForm] = useState(emptyMemberForm);
  const [memberFormError, setMemberFormError] = useState(false);
  const [duplicateNicknameError, setDuplicateNicknameError] = useState("");

  const [editingMemberId, setEditingMemberId] = useState(null);
  const [editMemberForm, setEditMemberForm] = useState(emptyMemberForm);
  const [editMemberFormError, setEditMemberFormError] = useState(false);
  const [editDuplicateNicknameError, setEditDuplicateNicknameError] = useState("");
  const [editDeleteError, setEditDeleteError] = useState("");
  const [isEditSelectMode, setIsEditSelectMode] = useState(false);

  const [isPlayCountModalOpen, setIsPlayCountModalOpen] = useState(false);
  const [tempPlayCounts, setTempPlayCounts] = useState({});
  const [tempPlayCountSpreadLimit, setTempPlayCountSpreadLimit] = useState(2);

  const [syncMessage, setSyncMessage] = useState("");
  const [lastSyncTime, setLastSyncTime] = useState("");
  const [autoSyncStatus, setAutoSyncStatus] = useState("");
  const [isSyncSaving, setIsSyncSaving] = useState(false);
  const [practiceDayPrompt, setPracticeDayPrompt] = useState(null);
  const [viewerUrlCopyMessage, setViewerUrlCopyMessage] = useState("");
  const [lastOperationDevice, setLastOperationDevice] = useState("");
  const [lastOperationTime, setLastOperationTime] = useState("");
  const [isCourtSwapMode, setIsCourtSwapMode] = useState(false);
  const [selectedCourtSwapIndex, setSelectedCourtSwapIndex] = useState(null);
  const [confirmingCourts, setConfirmingCourts] = useState({});
  const [rateHistoryItems, setRateHistoryItems] = useState([]);
  const [rateHistoryLoading, setRateHistoryLoading] = useState(false);
  const [rateHistoryError, setRateHistoryError] = useState("");
  const [registrationSuccessMessage, setRegistrationSuccessMessage] = useState("");

  const [isAdminSettingsOpen, setIsAdminSettingsOpen] = useState(false);
  const [adminPasswordInput, setAdminPasswordInput] = useState("");
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [adminPanel, setAdminPanel] = useState("menu");
  const [rateChangeBase, setRateChangeBase] = useState(DEFAULT_RATE_CHANGE_BASE);
  const [rankInitialRates, setRankInitialRates] = useState(DEFAULT_RANK_INITIAL_RATES);
  const [rateProfiles, setRateProfiles] = useState(DEFAULT_RATE_PROFILES);


  const [selectedRateEditMember, setSelectedRateEditMember] = useState(null);
  const [rateEditValue, setRateEditValue] = useState(0);

  const [selectedAdminMember, setSelectedAdminMember] = useState(null);
  const [adminMemberEditForm, setAdminMemberEditForm] = useState({
    nickname: "",
    reading: "",
    gender: "",
    rank: "",
    rate: 3000,
  });
  const [adminMemberEditError, setAdminMemberEditError] = useState("");

  const participationGroupRefs = useRef({});
  const viewerGroupRefs = useRef({});
  const adminGroupRefs = useRef({});
  const deviceTypeRef = useRef(detectDeviceType());
  const syncClientIdRef = useRef(
    `client-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  // latestSyncVersionRef は時刻ではなく、Firestore上の原子的な連番 revision を保持します。
  const latestSyncVersionRef = useRef(0);
  const syncInitializedRef = useRef(false);
  const pendingSaveCountRef = useRef(0);
  const saveQueueRef = useRef(Promise.resolve());
  const pendingRemoteSyncRef = useRef(null);
  // メンバー表示安定化1：サーバー由来の一覧を取得済みか保持し、
  // 後から届く古いキャッシュで表示中のメンバー一覧を巻き戻さない。
  const membersServerReadyRef = useRef(false);
  const [adminSettingsForm, setAdminSettingsForm] = useState({
    circleName: "",
    circleId: "",
    password: "",
    masterPassword: "",
    viewerPassword: "",
    defaultRateDisplay: "あり",
    defaultReadingDisplay: "なし",
  });

  const activeGroup = useMemo(() => {
    return groups.find((group) => group.id === activeGroupId) || null;
  }, [groups, activeGroupId]);

  const isViewerMode = userMode === "viewer";
  const isReadingVisible = currentCircle?.defaultReadingDisplay === "あり";
  const viewerUrl = currentCircle ? buildViewerUrl(currentCircle.circleId) : "";

  useEffect(() => {
    if (!currentCircle?.circleId) return;

    const circleRef = doc(db, "circles", currentCircle.circleId);

    const unsubscribe = onSnapshot(
      circleRef,
      (snapshot) => {
        if (!snapshot.exists()) return;

        const circleData = snapshot.data();

        setCurrentCircle((prevCircle) => {
          if (!prevCircle) return prevCircle;

          return {
            ...prevCircle,
            circleName: circleData.circleName || prevCircle.circleName,
            defaultRateDisplay: circleData.defaultRateDisplay || "あり",
            defaultReadingDisplay: circleData.defaultReadingDisplay || "なし",
            rateChangeBase: circleData.rateChangeBase || DEFAULT_RATE_CHANGE_BASE,
            rankInitialRates: circleData.rankInitialRates || DEFAULT_RANK_INITIAL_RATES,
            rateProfiles: circleData.rateProfiles || DEFAULT_RATE_PROFILES,
          };
        });

        setRateChangeBase(circleData.rateChangeBase || DEFAULT_RATE_CHANGE_BASE);
        setRankInitialRates(circleData.rankInitialRates || DEFAULT_RANK_INITIAL_RATES);
        setRateProfiles(circleData.rateProfiles || DEFAULT_RATE_PROFILES);
      },
      (error) => {
        console.error("サークル設定自動同期失敗", error);
      }
    );

    return () => unsubscribe();
  }, [currentCircle?.circleId]);

  const viewerSelectedMember = useMemo(() => {
    if (!viewerSelectedMemberId) return null;
    return members.find((member) => member.id === viewerSelectedMemberId) || null;
  }, [members, viewerSelectedMemberId]);

  useEffect(() => {
    if (groups.length > 0 && !activeGroupId) {
      setActiveGroupId(groups[0].id);
      setScreen("main");
    }

    if (groups.length === 0 && screen === "main") {
      setScreen("home");
    }
  }, [groups, activeGroupId, screen]);


  useEffect(() => {
    latestSyncVersionRef.current = 0;
    syncInitializedRef.current = false;
    pendingSaveCountRef.current = 0;
    pendingRemoteSyncRef.current = null;
    saveQueueRef.current = Promise.resolve();
    membersServerReadyRef.current = false;
    setIsSyncSaving(false);
    setLastOperationDevice("");
    setLastOperationTime("");
    setIsCourtSwapMode(false);
    setSelectedCourtSwapIndex(null);
    setConfirmingCourts({});
  }, [currentCircle?.circleId]);

  useEffect(() => {
    if (!currentCircle?.circleId) return;

    const syncRef = doc(
      db,
      "circles",
      currentCircle.circleId,
      "sync",
      "current"
    );

    setAutoSyncStatus("サーバー同期を確認中");

    const unsubscribe = onSnapshot(
      syncRef,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (!snapshot.exists()) {
          if (!snapshot.metadata.fromCache) {
            syncInitializedRef.current = true;
            latestSyncVersionRef.current = 0;
            setAutoSyncStatus("同期データ待機中");
          }
          return;
        }

        const data = snapshot.data();
        const incomingRevision = getSyncRevision(data);

        // Firestoreは最初に端末内キャッシュを返すことがあります。
        // ここを画面へ反映すると、数分前の状態へ一時的または恒久的に戻る原因になります。
        if (snapshot.metadata.fromCache) {
          setAutoSyncStatus("サーバーの最新状態を確認中");
          return;
        }

        // 自分自身の未確定ローカル書き込みは、すでに画面へ反映済みなので無視します。
        if (
          snapshot.metadata.hasPendingWrites &&
          data.updatedBy === syncClientIdRef.current
        ) {
          return;
        }

        if (
          syncInitializedRef.current &&
          incomingRevision <= latestSyncVersionRef.current
        ) {
          setAutoSyncStatus("自動同期中");
          return;
        }

        // 保存処理中に別端末の更新が来た場合、保存トランザクションの結果が出るまで保留します。
        if (pendingSaveCountRef.current > 0) {
          pendingRemoteSyncRef.current = data;
          setAutoSyncStatus("他端末の更新を確認中");
          return;
        }

        applyRemoteSyncData(data, {
          message: "他端末の最新状態を自動反映しました",
          allowPracticePrompt: userMode !== "viewer",
        });
        setAutoSyncStatus("自動同期中");
      },
      (error) => {
        console.error("自動同期失敗", error);
        setAutoSyncStatus("自動同期エラー");
        setSyncMessage("自動同期に失敗しました。通信状態を確認してください");
      }
    );

    return () => unsubscribe();
  }, [currentCircle?.circleId, userMode]);

  useEffect(() => {
    if (!currentCircle?.circleId) return;

    const membersRef = collection(
      db,
      "circles",
      currentCircle.circleId,
      "members"
    );

    const unsubscribe = onSnapshot(
      membersRef,
      { includeMetadataChanges: true },
      (snapshot) => {
        // メンバー表示安定化1：一度サーバーの最新一覧を確認した後は、
        // pending write を含まない古い端末キャッシュで一覧を巻き戻さない。
        if (
          snapshot.metadata.fromCache &&
          membersServerReadyRef.current &&
          !snapshot.metadata.hasPendingWrites
        ) {
          return;
        }

        if (!snapshot.metadata.fromCache) {
          membersServerReadyRef.current = true;
        }

        const loadedMembers = snapshot.docs.map((memberDoc) => ({
          id: memberDoc.id,
          ...memberDoc.data(),
        }));

        setMembers(loadedMembers);
      },
      (error) => {
        console.error("メンバー自動同期失敗", error);
        setSyncMessage("メンバー自動同期に失敗しました");
      }
    );

    return () => unsubscribe();
  }, [currentCircle?.circleId]);

  const getMembersCollectionRef = (circleId) => {
    return collection(db, "circles", circleId, "members");
  };

  const getMemberDocRef = (circleId, memberId) => {
    return doc(db, "circles", circleId, "members", memberId);
  };

  const loadMembersFromFirestore = async (circleId) => {
    setMemberLoading(true);

    try {
      const membersRef = getMembersCollectionRef(circleId);
      let snapshot;

      try {
        // メンバー表示安定化1：可能な限り必ずサーバーの最新一覧を取得する。
        snapshot = await getDocsFromServer(membersRef);
        membersServerReadyRef.current = true;
      } catch (serverError) {
        console.warn("メンバーのサーバー取得に失敗したためキャッシュを使用", serverError);
        snapshot = await getDocs(membersRef);
      }

      const loadedMembers = snapshot.docs.map((memberDoc) => ({
        id: memberDoc.id,
        ...memberDoc.data(),
      }));

      setMembers(loadedMembers);
      return loadedMembers;
    } catch (error) {
      setAuthError("メンバー情報の読み込みに失敗しました");
      return [];
    } finally {
      setMemberLoading(false);
    }
  };

  const refreshMembersFromServer = async (circleId) => {
    if (!circleId) return [];

    try {
      const membersRef = getMembersCollectionRef(circleId);
      const snapshot = await getDocsFromServer(membersRef);
      const loadedMembers = snapshot.docs.map((memberDoc) => ({
        id: memberDoc.id,
        ...memberDoc.data(),
      }));

      membersServerReadyRef.current = true;
      setMembers(loadedMembers);
      return loadedMembers;
    } catch (error) {
      console.error("メンバー最新一覧の再取得失敗", error);
      return [];
    }
  };

  // メンバー表示安定化2：参加画面を開くたびにサーバーの最新一覧を確認する。
  // サーバーに接続できない場合はFirestoreキャッシュ、さらに失敗した場合は現在の表示を維持する。
  const refreshMembersForParticipation = async () => {
    if (!currentCircle?.circleId) return members;

    setMemberLoading(true);

    try {
      const membersRef = getMembersCollectionRef(currentCircle.circleId);
      let snapshot;

      try {
        snapshot = await getDocsFromServer(membersRef);
        membersServerReadyRef.current = true;
      } catch (serverError) {
        console.warn(
          "参加画面のメンバーをサーバーから取得できないためキャッシュを確認します",
          serverError
        );
        snapshot = await getDocs(membersRef);
      }

      const loadedMembers = snapshot.docs.map((memberDoc) => ({
        id: memberDoc.id,
        ...memberDoc.data(),
      }));

      setMembers(loadedMembers);
      return loadedMembers;
    } catch (error) {
      console.error("参加画面のメンバー最新化に失敗", error);
      setParticipationError(
        "最新メンバーの取得に失敗したため、この端末に保存されている一覧を表示しています"
      );
      return members;
    } finally {
      setMemberLoading(false);
    }
  };

  const saveMemberToFirestore = async (circleId, member) => {
    const memberRef = getMemberDocRef(circleId, member.id);
    await setDoc(memberRef, member);
  };

  const deleteMemberFromFirestore = async (circleId, memberId) => {
    const memberRef = getMemberDocRef(circleId, memberId);
    await deleteDoc(memberRef);
  };

  const getSyncDocRef = (circleId) => {
    return doc(db, "circles", circleId, "sync", "current");
  };

  const formatSyncTime = () => {
    const now = new Date();
    return now.toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const getSyncRevision = (data) => {
    if (typeof data?.revision === "number" && Number.isFinite(data.revision)) {
      return data.revision;
    }

    // 旧版データから安全に移行するため、旧 updatedAtMillis を初回revisionとして利用します。
    if (
      typeof data?.updatedAtMillis === "number" &&
      Number.isFinite(data.updatedAtMillis)
    ) {
      return data.updatedAtMillis;
    }

    return 0;
  };

  const applyRemoteSyncData = (
    data,
    { message = "最新状態を反映しました", allowPracticePrompt = true } = {}
  ) => {
    const incomingRevision = getSyncRevision(data);
    const loadedGroups = Array.isArray(data?.groups) ? data.groups : [];
    const loadedPracticeDate = data?.practiceDate || getPracticeDateKey();
    const todayPracticeDate = getPracticeDateKey();

    latestSyncVersionRef.current = incomingRevision;
    syncInitializedRef.current = true;

    setGroups(loadedGroups);

    // グループ独立化1：activeGroupId は端末ごとの表示状態。
    // 他端末が中級を開いたからといって、この端末の上級表示を中級へ切り替えない。
    setActiveGroupId((currentActiveGroupId) => {
      if (
        currentActiveGroupId &&
        loadedGroups.some((group) => group.id === currentActiveGroupId)
      ) {
        return currentActiveGroupId;
      }

      return loadedGroups[0]?.id || null;
    });
    setScreen(loadedGroups.length > 0 ? "main" : "home");

    setLastOperationDevice(data?.updatedDevice || "");
    setLastOperationTime(formatOperationTime(data?.updatedAtMillis));

    if (
      allowPracticePrompt &&
      loadedGroups.length > 0 &&
      loadedPracticeDate !== todayPracticeDate
    ) {
      setPracticeDayPrompt({
        previousPracticeDate: loadedPracticeDate,
        todayPracticeDate,
      });
    }

    setLastSyncTime(formatSyncTime());
    setSyncMessage(message);
  };

  const applyPendingRemoteSyncIfNeeded = () => {
    const pendingData = pendingRemoteSyncRef.current;
    pendingRemoteSyncRef.current = null;

    if (!pendingData) return;

    const pendingRevision = getSyncRevision(pendingData);

    if (pendingRevision > latestSyncVersionRef.current) {
      applyRemoteSyncData(pendingData, {
        message: "保存中に届いた他端末の最新状態を反映しました",
        allowPracticePrompt: userMode !== "viewer",
      });
    }
  };

  const performGroupsSave = async (
    nextGroups,
    nextActiveGroupId,
    options = {}
  ) => {
    const targetCircleId = options.circleId || currentCircle?.circleId;

    if (!targetCircleId) return false;

    pendingSaveCountRef.current += 1;
    setIsSyncSaving(true);
    setAutoSyncStatus("保存中");

    const expectedRevision = latestSyncVersionRef.current;
    const operationTimeMillis = Date.now();
    const operationId = `${syncClientIdRef.current}-${operationTimeMillis}-${Math.random()
      .toString(36)
      .slice(2)}`;

    try {
      const syncRef = getSyncDocRef(targetCircleId);

      const result = await runTransaction(db, async (transaction) => {
        const latestSnap = await transaction.get(syncRef);
        const latestData = latestSnap.exists() ? latestSnap.data() : null;
        const remoteRevision = getSyncRevision(latestData);

        // 読み込んだrevisionとサーバーのrevisionが違う場合は、絶対に上書きしません。
        if (remoteRevision !== expectedRevision) {
          return {
            saved: false,
            conflict: true,
            remoteData: latestData,
            remoteRevision,
          };
        }

        const nextRevision = remoteRevision + 1;

        transaction.set(syncRef, {
          groups: nextGroups,
          // グループ独立化1：どのグループを開いているかは端末ローカルの状態なので同期しない。
          practiceDate: getPracticeDateKey(),
          revision: nextRevision,
          baseRevision: remoteRevision,
          schemaVersion: 2,
          operationId,
          updatedAtMillis: operationTimeMillis,
          updatedBy: syncClientIdRef.current,
          updatedDevice: deviceTypeRef.current,
          updatedAt: serverTimestamp(),
        });

        return {
          saved: true,
          conflict: false,
          nextRevision,
        };
      });

      if (!result.saved) {
        if (result.remoteData) {
          applyRemoteSyncData(result.remoteData, {
            message:
              "別端末が先に更新したため、この端末の古い保存は中止し、最新状態を反映しました",
            allowPracticePrompt: userMode !== "viewer",
          });
        } else {
          latestSyncVersionRef.current = result.remoteRevision || 0;
          syncInitializedRef.current = true;
          setSyncMessage(
            "別端末の更新と重なったため保存を中止しました。もう一度操作してください"
          );
        }

        setAutoSyncStatus("競合を安全に解消しました");
        return false;
      }

      latestSyncVersionRef.current = result.nextRevision;
      syncInitializedRef.current = true;
      setLastSyncTime(formatSyncTime());
      setLastOperationDevice(deviceTypeRef.current);
      setLastOperationTime(formatOperationTime(operationTimeMillis));
      setSyncMessage(options.successMessage || "保存・同期しました");
      setAutoSyncStatus("自動同期中");
      return true;
    } catch (error) {
      console.error("同期保存失敗", error);
      setSyncMessage(
        "同期保存に失敗しました。通信を確認し、画面の同期ボタンで最新状態を読み込んでください"
      );
      setAutoSyncStatus("保存エラー");
      return false;
    } finally {
      pendingSaveCountRef.current = Math.max(
        0,
        pendingSaveCountRef.current - 1
      );

      if (pendingSaveCountRef.current === 0) {
        setIsSyncSaving(false);
        applyPendingRemoteSyncIfNeeded();
      }
    }
  };

  const saveGroupsToFirestore = (
    nextGroups = groups,
    nextActiveGroupId = activeGroupId,
    options = {}
  ) => {
    // 同じ端末内の保存も必ず1件ずつ順番に処理します。
    // 連打や複数コートの同時操作で、古い保存が後から到着することを防ぎます。
    const queuedSave = saveQueueRef.current
      .catch(() => undefined)
      .then(() =>
        performGroupsSave(nextGroups, nextActiveGroupId, options)
      );

    saveQueueRef.current = queuedSave.then(
      () => undefined,
      () => undefined
    );

    return queuedSave;
  };

  const loadGroupsFromFirestore = async () => {
    if (!currentCircle || isSyncSaving) return;

    setAutoSyncStatus("サーバーから最新状態を取得中");

    try {
      const syncRef = getSyncDocRef(currentCircle.circleId);
      // getDoc では端末キャッシュが返る場合があるため、手動同期は必ずサーバーを参照します。
      const snap = await getDocFromServer(syncRef);

      if (!snap.exists()) {
        latestSyncVersionRef.current = 0;
        syncInitializedRef.current = true;
        setSyncMessage("同期データはまだありません");
        setAutoSyncStatus("同期データ待機中");
        return;
      }

      const data = snap.data();
      applyRemoteSyncData(data, {
        message: "サーバーの最新状態を読み込みました",
        allowPracticePrompt: userMode !== "viewer",
      });
      setAutoSyncStatus("自動同期中");
    } catch (error) {
      console.error("同期読み込み失敗", error);
      setSyncMessage(
        "サーバーから最新状態を取得できませんでした。通信状態を確認してください"
      );
      setAutoSyncStatus("読み込みエラー");
    }
  };
  const handleCreateCircle = async () => {
    const circleName = createCircleForm.circleName.trim();
    const circleId = normalizeCircleId(createCircleForm.circleId);
    const password = createCircleForm.password.trim();
    const masterPassword = createCircleForm.masterPassword.trim();
    const viewerPassword = createCircleForm.viewerPassword.trim();
    const createKey = createCircleForm.createKey.trim();

    if (!circleName || !circleId || !password || !masterPassword || !viewerPassword || !createKey) {
      setAuthError("すべて入力してください");
      return;
    }

    if (createKey !== CREATE_CIRCLE_KEY) {
      setAuthError("サークル作成キーが違います");
      return;
    }

    setAuthLoading(true);
    setAuthError("");

    try {
      const circleRef = doc(db, "circles", circleId);
      const circleSnap = await getDoc(circleRef);

      if (circleSnap.exists()) {
        setAuthError("このサークルIDはすでに使われています");
        setAuthLoading(false);
        return;
      }

      const newCircle = {
        circleName,
        circleId,
        password,
        masterPassword,
        viewerPassword,
        defaultRateDisplay: "あり",
        defaultReadingDisplay: "なし",
        rateChangeBase: DEFAULT_RATE_CHANGE_BASE,
        rankInitialRates: DEFAULT_RANK_INITIAL_RATES,
        rateProfiles: DEFAULT_RATE_PROFILES,
        createdAt: serverTimestamp(),
      };

      await setDoc(circleRef, newCircle);

      setCurrentCircle({
        circleName,
        circleId,
        defaultRateDisplay: "あり",
        defaultReadingDisplay: "なし",
        rateChangeBase: DEFAULT_RATE_CHANGE_BASE,
        rankInitialRates: DEFAULT_RANK_INITIAL_RATES,
        rateProfiles: DEFAULT_RATE_PROFILES,
      });
      setUserMode("normal");
      setViewerStep("none");

      setMembers([]);
      setGroups([]);
      setActiveGroupId(null);
      setScreen("home");
      setAuthMode("login");
      setCreateCircleForm({
        circleName: "",
        circleId: "",
        password: "",
        masterPassword: "",
        viewerPassword: "",
        createKey: "",
      });
    } catch (error) {
      setAuthError("サークル作成に失敗しました");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLoginCircle = async () => {
    const circleId = normalizeCircleId(loginForm.circleId);
    const password = loginForm.password.trim();

    if (!circleId || !password) {
      setAuthError("サークルIDとパスワードを入力してください");
      return;
    }

    setAuthLoading(true);
    setAuthError("");

    try {
      const circleRef = doc(db, "circles", circleId);
      const circleSnap = await getDoc(circleRef);

      if (!circleSnap.exists()) {
        setAuthError("サークルIDが見つかりません");
        setAuthLoading(false);
        return;
      }

      const circleData = circleSnap.data();

      const isNormalPassword = circleData.password === password;
      const isViewerPassword =
        circleData.viewerPassword && circleData.viewerPassword === password;

      if (!isNormalPassword && !isViewerPassword) {
        setAuthError("パスワードが違います");
        setAuthLoading(false);
        return;
      }

      setUserMode(isViewerPassword ? "viewer" : "normal");
      setViewerStep(isViewerPassword ? "confirm" : "none");

      setCurrentCircle({
        circleName: circleData.circleName,
        circleId: circleData.circleId,
        defaultRateDisplay: circleData.defaultRateDisplay || "あり",
        defaultReadingDisplay: circleData.defaultReadingDisplay || "なし",
        rateChangeBase: circleData.rateChangeBase || DEFAULT_RATE_CHANGE_BASE,
        rankInitialRates: circleData.rankInitialRates || DEFAULT_RANK_INITIAL_RATES,
        rateProfiles: circleData.rateProfiles || DEFAULT_RATE_PROFILES,
      });

      setRateChangeBase(circleData.rateChangeBase || DEFAULT_RATE_CHANGE_BASE);
      setRankInitialRates(circleData.rankInitialRates || DEFAULT_RANK_INITIAL_RATES);
      setRateProfiles(circleData.rateProfiles || DEFAULT_RATE_PROFILES);

      setLoginForm({
        circleId: "",
        password: "",
      });

      setGroups([]);
      setActiveGroupId(null);
      setScreen("home");

      await loadMembersFromFirestore(circleId);

      try {
        const syncRef = doc(db, "circles", circleId, "sync", "current");
        const syncSnap = await getDocFromServer(syncRef);

        if (syncSnap.exists()) {
          applyRemoteSyncData(syncSnap.data(), {
            message: "サーバーの最新状態を読み込みました",
            allowPracticePrompt: !isViewerPassword,
          });
        } else {
          latestSyncVersionRef.current = 0;
          syncInitializedRef.current = true;
        }
      } catch (syncError) {
        console.error("同期読み込み失敗", syncError);
      }
    } catch (error) {
      setAuthError("ログインに失敗しました");
    } finally {
      setAuthLoading(false);
    }
  };

  const loginViewerByCircleId = async (circleIdFromUrl) => {
    const circleId = normalizeCircleId(circleIdFromUrl || "");

    if (!circleId) return;

    setAuthLoading(true);
    setAuthError("");

    try {
      const circleRef = doc(db, "circles", circleId);
      const circleSnap = await getDoc(circleRef);

      if (!circleSnap.exists()) {
        setAuthError("閲覧用URLのサークルIDが見つかりません");
        return;
      }

      const circleData = circleSnap.data();

      setUserMode("viewer");
      setViewerStep("confirm");

      setCurrentCircle({
        circleName: circleData.circleName,
        circleId: circleData.circleId || circleId,
        defaultRateDisplay: circleData.defaultRateDisplay || "あり",
        defaultReadingDisplay: circleData.defaultReadingDisplay || "なし",
        rateChangeBase: circleData.rateChangeBase || DEFAULT_RATE_CHANGE_BASE,
        rankInitialRates: circleData.rankInitialRates || DEFAULT_RANK_INITIAL_RATES,
        rateProfiles: circleData.rateProfiles || DEFAULT_RATE_PROFILES,
      });

      setRateChangeBase(circleData.rateChangeBase || DEFAULT_RATE_CHANGE_BASE);
      setRankInitialRates(circleData.rankInitialRates || DEFAULT_RANK_INITIAL_RATES);
      setRateProfiles(circleData.rateProfiles || DEFAULT_RATE_PROFILES);

      await loadMembersFromFirestore(circleId);

      const syncRef = doc(db, "circles", circleId, "sync", "current");
      const syncSnap = await getDocFromServer(syncRef);

      if (syncSnap.exists()) {
        applyRemoteSyncData(syncSnap.data(), {
          message: "閲覧用の最新状態を読み込みました",
          allowPracticePrompt: false,
        });
      } else {
        latestSyncVersionRef.current = 0;
        syncInitializedRef.current = true;
        setGroups([]);
        setActiveGroupId(null);
        setScreen("home");
      }
    } catch (error) {
      console.error("閲覧用URLログイン失敗", error);
      setAuthError("閲覧用URLでの読み込みに失敗しました");
    } finally {
      setAuthLoading(false);
    }
  };

  useEffect(() => {
    if (currentCircle) return;

    const viewerCircleId = getViewerCircleIdFromUrl();

    if (viewerCircleId) {
      loginViewerByCircleId(viewerCircleId);
    }
  }, [currentCircle]);

  const copyViewerUrl = async () => {
    if (!viewerUrl) return;

    try {
      await navigator.clipboard.writeText(viewerUrl);
      setViewerUrlCopyMessage("URLをコピーしました");
    } catch (error) {
      setViewerUrlCopyMessage("コピーできませんでした。URLを長押ししてコピーしてください");
    }
  };

  const logoutCircle = () => {
    setCurrentCircle(null);
    setUserMode("normal");
    setViewerStep("none");
    setViewerMemberForm(emptyMemberForm);
    setViewerMemberFormError(false);
    setViewerDuplicateNicknameError("");
    setViewerSelectedMemberId("");
    setIsViewerGuideOpen(false);
    setViewerMemberSearch("");
    setMembers([]);
    setGroups([]);
    setActiveGroupId(null);
    setScreen("home");
    setIsParticipationModalOpen(false);
    setTempSelectedIds([]);
    setPracticeDayPrompt(null);
    setViewerUrlCopyMessage("");
    setLastOperationDevice("");
    setLastOperationTime("");
    setIsCourtSwapMode(false);
    setSelectedCourtSwapIndex(null);
    setConfirmingCourts({});
    latestSyncVersionRef.current = 0;
    syncInitializedRef.current = false;
    pendingSaveCountRef.current = 0;
    pendingRemoteSyncRef.current = null;
    saveQueueRef.current = Promise.resolve();
    setIsSyncSaving(false);

  };

  const updateActiveGroup = (updater) => {
    setGroups((prevGroups) =>
      prevGroups.map((group) => {
        if (group.id !== activeGroupId) return group;

        const patch = typeof updater === "function" ? updater(group) : updater;
        return {
          ...group,
          ...patch,
        };
      })
    );
  };

  const waitingMembers = activeGroup?.waitingMembers || [];
  const courts = activeGroup?.courts || [];
  const pairHistory = activeGroup?.pairHistory || {};
  const opponentHistory = activeGroup?.opponentHistory || {};
  const relationshipHistory = activeGroup?.relationshipHistory || {};
  const courtGroupHistory = activeGroup?.courtGroupHistory || {};
  const playCounts = activeGroup?.playCounts || {};
  const playCountSpreadLimit = activeGroup?.playCountSpreadLimit ?? 2;
  const selectedSwap = activeGroup?.selectedSwap || null;
  const isRateVisible = activeGroup?.rateDisplay === "あり";
  const isPlayCountVisible = activeGroup?.playCountVisible === "あり";

  const currentLayouts = createCourtCount
    ? layoutOptions[Number(createCourtCount)] || []
    : [];

  const sortedMembers = useMemo(() => {
    return [...members].sort((a, b) =>
      (a.reading || a.nickname || a.name).localeCompare(
        b.reading || b.nickname || b.name,
        "ja"
      )
    );
  }, [members]);

  const filteredViewerMembers = useMemo(() => {
    const keyword = viewerMemberSearch.trim();

    if (!keyword) return sortedMembers;

    return sortedMembers.filter((member) => {
      const nickname = member.nickname || member.name || "";
      const reading = member.reading || "";
      return nickname.includes(keyword) || reading.includes(keyword);
    });
  }, [sortedMembers, viewerMemberSearch]);

  const selectedLayout = useMemo(() => {
    if (!activeGroup) return null;
    const layouts = layoutOptions[Number(activeGroup.courtCount)] || [];
    return layouts.find((layout) => layout.id === activeGroup.layoutId) || null;
  }, [activeGroup]);

  const shouldShowRotateMessage = useMemo(() => {
    return hasThreeOrMoreHorizontalCourts(selectedLayout);
  }, [selectedLayout]);

  const displayLayout = selectedLayout;

  const selectedIds = useMemo(() => {
    const ids = new Set(waitingMembers.map((m) => m.id));
    courts.forEach((court) => {
      if (court) {
        [...court.teamA, ...court.teamB].forEach((m) => ids.add(m.id));
      }
    });
    return ids;
  }, [waitingMembers, courts]);

  const onCourtIds = useMemo(() => {
    const ids = new Set();
    courts.forEach((court) => {
      if (court) {
        [...court.teamA, ...court.teamB].forEach((m) => ids.add(m.id));
      }
    });
    return ids;
  }, [courts]);

  const filteredMembers = useMemo(() => {
    const keyword = memberSearch.trim();

    if (!keyword) return sortedMembers;

    return sortedMembers.filter((member) => {
      const nickname = member.nickname || member.name || "";
      const reading = member.reading || "";
      return nickname.includes(keyword) || reading.includes(keyword);
    });
  }, [sortedMembers, memberSearch]);

  const activePlayCountMembers = useMemo(() => {
    return sortedMembers.filter((member) => selectedIds.has(member.id));
  }, [sortedMembers, selectedIds]);


  const applyCourtLayoutChange = async (layoutId) => {
    if (!activeGroup || !layoutChangeMode || !pendingCourtCount) return;

    const nextCount = Number(pendingCourtCount);

    let syncedGroups = groups.map((group) => {
      if (group.id !== activeGroupId) return group;

      let nextCourts = [...group.courts];

      if (layoutChangeMode === "delete") {
        let removed = false;

        nextCourts = nextCourts.filter((court) => {
          if (!removed && !court) {
            removed = true;
            return false;
          }
          return true;
        });
      }

      if (layoutChangeMode === "add") {
        nextCourts.push(null);
      }

      return {
        ...group,
        courtCount: String(nextCount),
        layoutId,
        courts: nextCourts,
        selectedSwap: null,
      };
    });

    setGroups(syncedGroups);
    setLayoutChangeMode(null);
    setPendingCourtCount("");

    await saveGroupsToFirestore(syncedGroups, activeGroupId);
  };

  const resetCreateForm = () => {
    setCreateGroupName("");
    setCreateCourtCount("");
    setCreateLayoutId("");
    setCreatePlayCountVisible("");
    setCreatePointRule("");
    setCreatePlayCountSpreadLimit("");
    setGroupError(false);
  };

  const startCreateGroup = () => {
    resetCreateForm();
    setScreen("create");
  };

  const selectCourtCount = (count) => {
    const firstLayout = layoutOptions[count][0];
    setCreateCourtCount(String(count));
    setCreateLayoutId(firstLayout.id);
  };

  const createGroup = async () => {
    if (
      !createGroupName ||
      !createCourtCount ||
      !createLayoutId ||
      !createPlayCountVisible ||
      !createPointRule ||
      !createPlayCountSpreadLimit
    ) {
      setGroupError(true);
      return;
    }

    const newGroup = createGroupObject({
      groupName: createGroupName,
      courtCount: createCourtCount,
      layoutId: createLayoutId,
      rateDisplay: currentCircle?.defaultRateDisplay || "あり",
      playCountVisible: createPlayCountVisible,
      pointRule: createPointRule,
      playCountSpreadLimit: createPlayCountSpreadLimit,
    });

    const nextGroups = [...groups, newGroup];

    setGroups(nextGroups);
    setActiveGroupId(newGroup.id);
    resetCreateForm();
    setScreen("main");

    await saveGroupsToFirestore(nextGroups, newGroup.id);
  };

  const switchGroup = (groupId) => {
    setActiveGroupId(groupId);
    setScreen("main");
    setIsParticipationModalOpen(false);
    setTempSelectedIds([]);
    setMemberSearch("");
    setIsNewMemberFormOpen(false);
    setEditingMemberId(null);
    setEditDeleteError("");
    setIsEditSelectMode(false);
    setIsCourtSwapMode(false);
    setSelectedCourtSwapIndex(null);

  };

  const deleteActiveGroup = async () => {
    if (!activeGroup) return;

    const confirmDelete = window.confirm(
      `${activeGroup.groupName}のグループを削除しますか？`
    );

    if (!confirmDelete) return;

    const nextGroups = groups.filter((group) => group.id !== activeGroup.id);
    const nextActiveGroupId = nextGroups[0]?.id || null;

    setGroups(nextGroups);

    if (nextGroups.length > 0) {
      setActiveGroupId(nextActiveGroupId);
      setScreen("main");
    } else {
      setActiveGroupId(null);
      setScreen("home");
    }

    await saveGroupsToFirestore(nextGroups, nextActiveGroupId);
  };

  const getGameResultDocRef = (circleId, gameId) => {
    return doc(db, "circles", circleId, "gameResults", gameId);
  };

  const loadRateHistory = async () => {
    if (!currentCircle?.circleId) return;

    setRateHistoryLoading(true);
    setRateHistoryError("");

    try {
      const historyRef = collection(
        db,
        "circles",
        currentCircle.circleId,
        "gameResults"
      );
      const snapshot = await getDocsFromServer(historyRef);
      const items = snapshot.docs
        .map((itemDoc) => ({ id: itemDoc.id, ...itemDoc.data() }))
        .sort(
          (a, b) =>
            Number(b.confirmedAtMillis || 0) - Number(a.confirmedAtMillis || 0)
        )
        .slice(0, 50);

      setRateHistoryItems(items);
    } catch (error) {
      console.error("レート変更履歴の読み込み失敗", error);
      setRateHistoryError(
        "履歴を読み込めませんでした。Firestoreルールが最新版か確認してください。"
      );
    } finally {
      setRateHistoryLoading(false);
    }
  };

  const openAdminSettings = () => {
    setIsAdminSettingsOpen(true);
    setAdminPasswordInput("");
    setAdminUnlocked(false);
    setAdminError("");
    setRateHistoryError("");
    setAdminPanel("menu");
    setAdminSettingsForm({
      circleName: currentCircle?.circleName || "",
      circleId: currentCircle?.circleId || "",
      password: "",
      masterPassword: "",
      viewerPassword: "",
      defaultRateDisplay: currentCircle?.defaultRateDisplay || "あり",
      defaultReadingDisplay: currentCircle?.defaultReadingDisplay || "なし",
    });
  };

  const closeAdminSettings = () => {
    setIsAdminSettingsOpen(false);
    setAdminPasswordInput("");
    setAdminUnlocked(false);
    setAdminError("");
    setAdminPanel("menu");
    setSelectedAdminMember(null);
  };

  const verifyAdminPassword = async () => {
    if (!currentCircle) return;

    if (!adminPasswordInput.trim()) {
      setAdminError("マスターパスワードを入力してください");
      return;
    }

    try {
      const circleRef = doc(db, "circles", currentCircle.circleId);
      const circleSnap = await getDoc(circleRef);

      if (!circleSnap.exists()) {
        setAdminError("サークル情報が見つかりません");
        return;
      }

      const circleData = circleSnap.data();

      if (circleData.masterPassword !== adminPasswordInput.trim()) {
        setAdminError("マスターパスワードが違います");
        return;
      }

      setAdminUnlocked(true);
      setAdminError("");
      setAdminPanel("menu");
      setAdminSettingsForm({
        circleName: circleData.circleName || "",
        circleId: circleData.circleId || currentCircle.circleId,
        password: circleData.password || "",
        masterPassword: circleData.masterPassword || "",
        viewerPassword: circleData.viewerPassword || "",
        defaultRateDisplay: circleData.defaultRateDisplay || "あり",
        defaultReadingDisplay: circleData.defaultReadingDisplay || "なし",
      });

      setRateChangeBase(circleData.rateChangeBase || DEFAULT_RATE_CHANGE_BASE);
      setRankInitialRates(circleData.rankInitialRates || DEFAULT_RANK_INITIAL_RATES);
      setRateProfiles(circleData.rateProfiles || DEFAULT_RATE_PROFILES);
    } catch (error) {
      setAdminError("確認に失敗しました");
    }
  };

  const copySubCollection = async (oldCircleId, newCircleId, subCollectionName) => {
    const oldRef = collection(db, "circles", oldCircleId, subCollectionName);
    const snapshot = await getDocs(oldRef);

    await Promise.all(
      snapshot.docs.map((itemDoc) =>
        setDoc(
          doc(db, "circles", newCircleId, subCollectionName, itemDoc.id),
          itemDoc.data()
        )
      )
    );
  };

  const openAdminMemberEdit = (member) => {
    setSelectedAdminMember(member);
    setAdminMemberEditError("");
    setAdminMemberEditForm({
      nickname: member.nickname || member.name || "",
      reading: member.reading || "",
      gender: member.gender || "",
      rank: member.rank || "",
      rate: getMemberRate(member),
    });
  };

  const closeAdminMemberEdit = () => {
    setSelectedAdminMember(null);
    setAdminMemberEditError("");
    setAdminMemberEditForm({
      nickname: "",
      reading: "",
      gender: "",
      rank: "",
      rate: 3000,
    });
  };

  const saveAdminMemberEdit = async () => {
    if (!currentCircle || !selectedAdminMember) return;

    const nickname = adminMemberEditForm.nickname.trim();
    const reading = normalizeReadingInput(adminMemberEditForm.reading.trim());
    const gender = adminMemberEditForm.gender;
    const rank = adminMemberEditForm.rank;
    const rate = Number(adminMemberEditForm.rate);

    if (!nickname || !reading || !gender || !rank || Number.isNaN(rate)) {
      setAdminMemberEditError("すべて入力してください");
      return;
    }

    const duplicate = members.some((member) => {
      if (member.id === selectedAdminMember.id) return false;
      return (member.nickname || member.name) === nickname;
    });

    if (duplicate) {
      setAdminMemberEditError("同じニックネームがあります");
      return;
    }

    const editedData = {
      nickname,
      name: nickname,
      reading,
      gender,
      rank,
      rate,
      updatedAt: serverTimestamp(),
    };

    try {
      await setDoc(
        doc(db, "circles", currentCircle.circleId, "members", selectedAdminMember.id),
        editedData,
        { merge: true }
      );

      setMembers((prevMembers) =>
        prevMembers.map((member) =>
          member.id === selectedAdminMember.id
            ? { ...member, ...editedData }
            : member
        )
      );

      const updateMemberInGroup = (member) =>
        member.id === selectedAdminMember.id
          ? { ...member, ...editedData }
          : member;

      const nextGroups = groups.map((group) => ({
        ...group,
        waitingMembers: group.waitingMembers.map(updateMemberInGroup),
        courts: group.courts.map((court) => {
          if (!court) return court;

          return {
            ...court,
            teamA: court.teamA.map(updateMemberInGroup),
            teamB: court.teamB.map(updateMemberInGroup),
          };
        }),
      }));

      setGroups(nextGroups);
      await saveGroupsToFirestore(nextGroups, activeGroupId);

      setSyncMessage("メンバー情報を保存しました");
      closeAdminMemberEdit();
    } catch (error) {
      setAdminMemberEditError("保存に失敗しました");
    }
  };

  const deleteAdminMember = async () => {
    if (!currentCircle || !selectedAdminMember) return;

    const isInGroup = groups.some((group) => {
      const inWaiting = group.waitingMembers.some(
        (member) => member.id === selectedAdminMember.id
      );

      const inCourt = group.courts.some((court) => {
        if (!court) return false;
        return [...court.teamA, ...court.teamB].some(
          (member) => member.id === selectedAdminMember.id
        );
      });

      return inWaiting || inCourt;
    });

    if (isInGroup) {
      setAdminMemberEditError("参加中または試合中のため削除できません");
      return;
    }

    const ok = window.confirm(
      `${selectedAdminMember.nickname || selectedAdminMember.name}を削除しますか？`
    );

    if (!ok) return;

    try {
      await deleteDoc(
        doc(db, "circles", currentCircle.circleId, "members", selectedAdminMember.id)
      );

      setMembers((prevMembers) =>
        prevMembers.filter((member) => member.id !== selectedAdminMember.id)
      );

      setSyncMessage("メンバーを削除しました");
      closeAdminMemberEdit();
    } catch (error) {
      setAdminMemberEditError("削除に失敗しました");
    }
  };

  const resetAllRates = async () => {
    if (!currentCircle) return;

    const ok = window.confirm(
      "全メンバーのレートをランク初期値へ戻します。\nランクは保持されます。"
    );

    if (!ok) return;

    try {
      const nextMembers = members.map((member) => ({
        ...member,
        rate: getInitialRate(member.rank),
        updatedAt: serverTimestamp(),
      }));

      await Promise.all(
        nextMembers.map((member) =>
          setDoc(
            doc(db, "circles", currentCircle.circleId, "members", member.id),
            {
              rate: getInitialRate(member.rank),
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          )
        )
      );

      setMembers(nextMembers);
      setSyncMessage("全員のレートを初期化しました");
    } catch (error) {
      alert("レート初期化に失敗しました");
    }
  };

  const saveAdminSettings = async () => {
    if (!currentCircle) return;

    const nextCircleName = adminSettingsForm.circleName.trim();
    const nextCircleId = normalizeCircleId(adminSettingsForm.circleId);
    const nextPassword = adminSettingsForm.password.trim();
    const nextMasterPassword = adminSettingsForm.masterPassword.trim();
    const nextViewerPassword = adminSettingsForm.viewerPassword.trim();
    const nextDefaultRateDisplay = adminSettingsForm.defaultRateDisplay || "あり";
    const nextDefaultReadingDisplay = adminSettingsForm.defaultReadingDisplay || "なし";
    const nextRateChangeBase = Number(rateChangeBase) || DEFAULT_RATE_CHANGE_BASE;
    const nextRankInitialRates = rankInitialRates || DEFAULT_RANK_INITIAL_RATES;
    const nextRateProfiles = rateProfiles || DEFAULT_RATE_PROFILES;

    if (!nextCircleName || !nextCircleId || !nextPassword || !nextMasterPassword) {
      setAdminError("サークル名・ログインID・通常パスワード・管理者パスワードは必須です");
      return;
    }

    try {
      const oldCircleId = currentCircle.circleId;
      const oldCircleRef = doc(db, "circles", oldCircleId);
      const oldCircleSnap = await getDoc(oldCircleRef);

      if (!oldCircleSnap.exists()) {
        setAdminError("サークル情報が見つかりません");
        return;
      }

      const oldCircleData = oldCircleSnap.data();

      const nextCircleData = {
        ...oldCircleData,
        circleName: nextCircleName,
        circleId: nextCircleId,
        password: nextPassword,
        masterPassword: nextMasterPassword,
        viewerPassword: nextViewerPassword,
        defaultRateDisplay: nextDefaultRateDisplay,
        defaultReadingDisplay: nextDefaultReadingDisplay,
        rateChangeBase: nextRateChangeBase,
        rankInitialRates: nextRankInitialRates,
        rateProfiles: nextRateProfiles,
        updatedAt: serverTimestamp(),
      };

      if (nextCircleId !== oldCircleId) {
        const newCircleRef = doc(db, "circles", nextCircleId);
        const newCircleSnap = await getDoc(newCircleRef);

        if (newCircleSnap.exists()) {
          setAdminError("このログインIDはすでに使われています");
          return;
        }

        await setDoc(newCircleRef, nextCircleData);
        await copySubCollection(oldCircleId, nextCircleId, "members");
        await copySubCollection(oldCircleId, nextCircleId, "sync");
        await deleteDoc(oldCircleRef);
      } else {
        await setDoc(oldCircleRef, nextCircleData, { merge: true });
      }

      setCurrentCircle({
        ...currentCircle,
        circleName: nextCircleName,
        circleId: nextCircleId,
        defaultRateDisplay: nextDefaultRateDisplay,
        defaultReadingDisplay: nextDefaultReadingDisplay,
        rateChangeBase: nextRateChangeBase,
        rankInitialRates: nextRankInitialRates,
        rateProfiles: nextRateProfiles,
      });

      const nextGroupsForRateDisplay = groups.map((group) => ({
        ...group,
        rateDisplay: nextDefaultRateDisplay,
      }));

      if (nextGroupsForRateDisplay.length > 0) {
        const saved = await saveGroupsToFirestore(
          nextGroupsForRateDisplay,
          activeGroupId,
          {
            circleId: nextCircleId,
            successMessage: "管理者設定を保存・同期しました",
          }
        );

        if (!saved) {
          setAdminError(
            "他端末の更新と重なったため設定の同期を中止しました。最新状態を確認して、もう一度保存してください"
          );
          return;
        }

        setGroups(nextGroupsForRateDisplay);
      }

      setAdminError("");
      setSyncMessage("管理者設定を保存しました");
      setAdminPanel("menu");

      if (nextCircleId !== oldCircleId) {
        alert("ログインIDを変更しました。次回から新しいIDでログインしてください。");
      }
    } catch (error) {
      console.error("管理者設定保存失敗", error);
      setAdminError("管理者設定の保存に失敗しました");
    }
  };

  const resetTodayState = async (options = {}) => {
    if (!currentCircle) return;

    const skipConfirm = options?.skipConfirm === true;

    if (!skipConfirm) {
      const confirmReset = window.confirm(
        "練習を終了し、新しい練習を開始しますか？\n\n・参加状況をリセット\n・コート状況をリセット\n・参加回数をリセット\n・試合履歴をリセット\n\n※登録メンバーとレートは保持されます"
      );

      if (!confirmReset) return;
    }

    const nextGroups = [];
    const nextActiveGroupId = null;

    setGroups(nextGroups);
    setActiveGroupId(nextActiveGroupId);
    setScreen("home");
    setIsParticipationModalOpen(false);
    setTempSelectedIds([]);
    setMemberSearch("");
    setIsNewMemberFormOpen(false);
    setEditingMemberId(null);
    setIsEditSelectMode(false);
    setPracticeDayPrompt(null);

    await saveGroupsToFirestore(nextGroups, nextActiveGroupId);
  };

  const continuePreviousPracticeDay = async () => {
    setPracticeDayPrompt(null);
    await saveGroupsToFirestore(groups, activeGroupId);
    setSyncMessage("前回の練習状態を引き継ぎました");
  };

  const startNewPracticeDay = async () => {
    await resetTodayState({ skipConfirm: true });
    setSyncMessage("新しい練習日として開始しました");
  };

  const openCourtAddLayoutSelect = () => {
    if (!activeGroup) return;

    const nextCount = Number(activeGroup.courtCount) + 1;

    if (nextCount > 8) {
      alert("コートは最大8面までです");
      return;
    }

    setPendingCourtCount(String(nextCount));
    setLayoutChangeMode("add");
  };

  const openCourtDeleteLayoutSelect = () => {
    if (!activeGroup) return;

    const emptyCourtExists = courts.some((court) => !court);

    if (!emptyCourtExists) {
      alert("空きコートがありません");
      return;
    }

    if (Number(activeGroup.courtCount) <= 1) {
      alert("コートは1面未満にできません");
      return;
    }

    const confirmDelete = window.confirm("コートを削除しますか？");

    if (!confirmDelete) return;

    const nextCount = Number(activeGroup.courtCount) - 1;

    setPendingCourtCount(String(nextCount));
    setLayoutChangeMode("delete");
  };


  const normalizePlayCountValue = (value) => {
    return Math.max(0, Math.floor(Number(value) || 0));
  };

  const openPlayCountModal = () => {
    const nextTempPlayCounts = {};

    activePlayCountMembers.forEach((member) => {
      nextTempPlayCounts[member.id] = normalizePlayCountValue(
        playCounts[member.id]
      );
    });

    setTempPlayCounts(nextTempPlayCounts);
    setTempPlayCountSpreadLimit(activeGroup?.playCountSpreadLimit ?? 2);
    setIsPlayCountModalOpen(true);
  };

  const closePlayCountModal = () => {
    setIsPlayCountModalOpen(false);
    setTempPlayCounts({});
    setTempPlayCountSpreadLimit(2);
  };

  const changeTempPlayCount = (memberId, amount) => {
    setTempPlayCounts((prevCounts) => ({
      ...prevCounts,
      [memberId]: normalizePlayCountValue(prevCounts[memberId]) + amount < 0
        ? 0
        : normalizePlayCountValue(prevCounts[memberId]) + amount,
    }));
  };

  const savePlayCounts = async () => {
    if (!activeGroup) return;

    const nextGroups = groups.map((group) => {
      if (group.id !== activeGroupId) return group;

      const nextPlayCounts = { ...(group.playCounts || {}) };

      activePlayCountMembers.forEach((member) => {
        nextPlayCounts[member.id] = normalizePlayCountValue(
          tempPlayCounts[member.id]
        );
      });

      return {
        ...group,
        playCounts: nextPlayCounts,
        playCountSpreadLimit: tempPlayCountSpreadLimit,
        selectedSwap: null,
      };
    });

    setGroups(nextGroups);

    const saved = await saveGroupsToFirestore(nextGroups, activeGroupId);

    if (saved) {
      setSyncMessage("参加回数を保存・同期しました");
      closePlayCountModal();
    } else {
      setSyncMessage("参加回数の同期に失敗しました");
    }
  };

  const openParticipationModal = async () => {
    const ids = new Set();

    waitingMembers.forEach((member) => ids.add(member.id));

    courts.forEach((court) => {
      if (court) {
        [...court.teamA, ...court.teamB].forEach((member) =>
          ids.add(member.id)
        );
      }
    });

    setTempSelectedIds(Array.from(ids));
    setMemberSearch("");
    setIsNewMemberFormOpen(false);
    setMemberForm(emptyMemberForm);
    setMemberFormError(false);
    setDuplicateNicknameError("");
    setIsImportMemberModalOpen(false);
    setImportCircleForm({ circleId: "", password: "" });
    setImportMembers([]);
    setImportSelectedIds([]);
    setImportError("");
    setImportLoading(false);
    setEditingMemberId(null);
    setEditMemberForm(emptyMemberForm);
    setEditMemberFormError(false);
    setEditDuplicateNicknameError("");
    setEditDeleteError("");
    setParticipationError("");
    setIsParticipationModalOpen(true);

    // 画面を先に開いて「読み込み中」を見せ、その後サーバーの最新メンバーを反映する。
    await refreshMembersForParticipation();
  };

  const closeParticipationModal = () => {
    setIsParticipationModalOpen(false);
    setTempSelectedIds([]);
    setParticipationError("");
    setMemberSearch("");
    setIsNewMemberFormOpen(false);
    setMemberForm(emptyMemberForm);
    setMemberFormError(false);
    setDuplicateNicknameError("");
    setIsImportMemberModalOpen(false);
    setImportCircleForm({ circleId: "", password: "" });
    setImportMembers([]);
    setImportSelectedIds([]);
    setImportError("");
    setImportLoading(false);
    setEditingMemberId(null);
    setEditMemberForm(emptyMemberForm);
    setEditMemberFormError(false);
    setEditDuplicateNicknameError("");
    setEditDeleteError("");
    setIsEditSelectMode(false);
    setRegistrationSuccessMessage("");

  };

  const toggleTempMember = (member) => {
    if (onCourtIds.has(member.id)) {
      setParticipationError("試合中のため変更できません");
      return;
    }

    if (editingMemberId) return;

    setParticipationError("");

    setTempSelectedIds((prevIds) => {
      if (prevIds.includes(member.id)) {
        return prevIds.filter((id) => id !== member.id);
      }

      return [...prevIds, member.id];
    });
  };

  const decideParticipation = async () => {
    const courtMemberIds = new Set(onCourtIds);
    const tempIdSet = new Set(tempSelectedIds);

    const selectedWaitingMembers = sortedMembers.filter(
      (member) => tempIdSet.has(member.id) && !courtMemberIds.has(member.id)
    );

    const nextGroups = groups.map((group) => {
      if (group.id !== activeGroupId) return group;

      const nextPlayCounts = { ...(group.playCounts || {}) };
      const initialPlayCount = getInitialPlayCountForGroup(group);

      selectedWaitingMembers.forEach((member) => {
        if (typeof nextPlayCounts[member.id] !== "number") {
          nextPlayCounts[member.id] = initialPlayCount;
        }
      });

      return {
        ...group,
        waitingMembers: selectedWaitingMembers,
        playCounts: nextPlayCounts,
        selectedSwap: null,
      };
    });

    setGroups(nextGroups);
    closeParticipationModal();

    await saveGroupsToFirestore(nextGroups, activeGroupId);
  };

  const openImportMemberModal = () => {
    setIsParticipationModalOpen(false);
    setIsImportMemberModalOpen(false);
    setScreen("importMembers");
    setImportCircleForm({ circleId: "", password: "" });
    setImportMembers([]);
    setImportSelectedIds([]);
    setImportError("");
    setImportLoading(false);
    setIsNewMemberFormOpen(false);
    setEditingMemberId(null);
    setIsEditSelectMode(false);
  };

  const closeImportMemberScreen = () => {
    setScreen("main");
    setIsParticipationModalOpen(true);
    setIsImportMemberModalOpen(false);
    setImportCircleForm({ circleId: "", password: "" });
    setImportMembers([]);
    setImportSelectedIds([]);
    setImportError("");
    setImportLoading(false);
  };

  const loadImportMembers = async () => {
    const sourceCircleId = normalizeCircleId(importCircleForm.circleId);
    const sourcePassword = importCircleForm.password.trim();

    if (!sourceCircleId || !sourcePassword) {
      setImportError("コピー元のサークルIDとパスワードを入力してください");
      return;
    }

    if (currentCircle?.circleId && sourceCircleId === currentCircle.circleId) {
      setImportError("現在ログイン中のサークルとは別のサークルIDを入力してください");
      return;
    }

    setImportLoading(true);
    setImportError("");

    try {
      const sourceCircleRef = doc(db, "circles", sourceCircleId);
      const sourceCircleSnap = await getDoc(sourceCircleRef);

      if (!sourceCircleSnap.exists()) {
        setImportError("コピー元のサークルIDが見つかりません");
        setImportLoading(false);
        return;
      }

      const sourceCircleData = sourceCircleSnap.data();
      const canImport =
        sourceCircleData.password === sourcePassword ||
        sourceCircleData.masterPassword === sourcePassword;

      if (!canImport) {
        setImportError("コピー元のパスワードが違います");
        setImportLoading(false);
        return;
      }

      const sourceMembersRef = collection(db, "circles", sourceCircleId, "members");
      const sourceMembersSnap = await getDocs(sourceMembersRef);
      const loadedImportMembers = sourceMembersSnap.docs
        .map((memberDoc) => ({
          id: memberDoc.id,
          ...memberDoc.data(),
        }))
        .sort((a, b) =>
          (a.reading || a.nickname || a.name || "").localeCompare(
            b.reading || b.nickname || b.name || "",
            "ja"
          )
        );

      setImportMembers(loadedImportMembers);
      setImportSelectedIds([]);

      if (loadedImportMembers.length === 0) {
        setImportError("コピー元にメンバーが登録されていません");
      }
    } catch (error) {
      console.error("別アカウントメンバー読み込み失敗", error);
      setImportError("メンバーの読み込みに失敗しました");
    } finally {
      setImportLoading(false);
    }
  };

  const toggleImportMember = (memberId) => {
    setImportSelectedIds((prevIds) => {
      if (prevIds.includes(memberId)) {
        return prevIds.filter((id) => id !== memberId);
      }

      return [...prevIds, memberId];
    });
  };

  const saveImportedMembers = async () => {
    if (!currentCircle) return;

    if (importSelectedIds.length === 0) {
      setImportError("取り込むメンバーを選択してください");
      return;
    }

    const selectedImportMembers = importMembers.filter((member) =>
      importSelectedIds.includes(member.id)
    );

    const duplicateNames = selectedImportMembers.filter((member) =>
      nicknameExists(member.nickname || member.name || "")
    );

    if (duplicateNames.length > 0) {
      setImportError(
        `同じニックネームがあります：${duplicateNames
          .map((member) => member.nickname || member.name)
          .join("、")}`
      );
      return;
    }

    setImportLoading(true);
    setImportError("");

    try {
      const now = Date.now();
      const copiedMembers = selectedImportMembers.map((member, index) => {
        const nickname = member.nickname || member.name || "";
        const rank = member.rank || "初心者";

        return {
          id: `${now}-${index}`,
          nickname,
          name: nickname,
          reading: member.reading || "",
          gender: member.gender || "なし",
          rank,
          rate:
            typeof rankInitialRates?.[rank] === "number"
              ? rankInitialRates[rank]
              : getInitialRate(rank),
        };
      });

      await Promise.all(
        copiedMembers.map((member) =>
          saveMemberToFirestore(currentCircle.circleId, member)
        )
      );

      await refreshMembersFromServer(currentCircle.circleId);

      setTempSelectedIds((prevIds) => [
        ...prevIds,
        ...copiedMembers.map((member) => member.id),
      ]);

      setImportError("");
      setIsImportMemberModalOpen(false);
      setImportCircleForm({ circleId: "", password: "" });
      setImportMembers([]);
      setImportSelectedIds([]);
      setScreen("main");
      setIsParticipationModalOpen(true);
      setSyncMessage("別アカウントからメンバーを取り込みました");
    } catch (error) {
      console.error("別アカウントメンバー登録失敗", error);
      setImportError("メンバーの登録に失敗しました");
    } finally {
      setImportLoading(false);
    }
  };

  const nicknameExists = (nickname, ignoreId = null) => {
    return members.some((member) => {
      if (ignoreId && member.id === ignoreId) return false;
      return (member.nickname || member.name) === nickname.trim();
    });
  };

  const saveMember = async () => {
    if (!currentCircle) return;

    if (
      !memberForm.nickname.trim() ||
      !memberForm.reading.trim() ||
      !memberForm.gender ||
      !memberForm.rank
    ) {
      setMemberFormError(true);
      return;
    }

    if (nicknameExists(memberForm.nickname)) {
      setDuplicateNicknameError("同じニックネームがあります");
      return;
    }

    const newMember = {
      id: Date.now().toString(),
      nickname: memberForm.nickname.trim(),
      name: memberForm.nickname.trim(),
      reading: normalizeReadingInput(memberForm.reading.trim()),
      gender: memberForm.gender,
      rank: memberForm.rank,
      rate: getInitialRate(memberForm.rank),
    };

    try {
      await saveMemberToFirestore(currentCircle.circleId, newMember);

      setMembers((prevMembers) =>
        prevMembers.some((member) => member.id === newMember.id)
          ? prevMembers
          : [...prevMembers, newMember]
      );
      setTempSelectedIds((prevIds) => [...prevIds, newMember.id]);
      await refreshMembersForParticipation();
      setMemberForm(emptyMemberForm);
      setMemberFormError(false);
      setDuplicateNicknameError("");
      setIsNewMemberFormOpen(false);
      setRegistrationSuccessMessage("登録しました");
      window.setTimeout(() => setRegistrationSuccessMessage(""), 2200);
    } catch (error) {
      setDuplicateNicknameError("メンバー登録に失敗しました");
    }
  };

  const openEditMember = (member) => {
    setEditingMemberId(member.id);
    setEditMemberForm({
      nickname: member.nickname || member.name || "",
      reading: member.reading || "",
      gender: member.gender || "",
      rank: member.rank || "",
    });
    setEditMemberFormError(false);
    setEditDuplicateNicknameError("");
    setEditDeleteError("");
    setIsNewMemberFormOpen(false);
  };

  const closeEditMember = () => {
    setEditingMemberId(null);
    setEditMemberForm(emptyMemberForm);
    setEditMemberFormError(false);
    setEditDuplicateNicknameError("");
    setEditDeleteError("");
  };

  const saveEditedMember = async () => {
    if (!currentCircle) return;

    if (
      !editMemberForm.nickname.trim() ||
      !editMemberForm.reading.trim() ||
      !editMemberForm.gender
    ) {
      setEditMemberFormError(true);
      return;
    }

    if (nicknameExists(editMemberForm.nickname, editingMemberId)) {
      setEditDuplicateNicknameError("同じニックネームがあります");
      return;
    }

    const targetMember = members.find((member) => member.id === editingMemberId);
    if (!targetMember) return;

    const editedData = {
      nickname: editMemberForm.nickname.trim(),
      name: editMemberForm.nickname.trim(),
      reading: normalizeReadingInput(editMemberForm.reading.trim()),
      gender: editMemberForm.gender,
    };

    const editedMember = {
      ...targetMember,
      ...editedData,
    };

    try {
      await saveMemberToFirestore(currentCircle.circleId, editedMember);

      setMembers((prevMembers) =>
        prevMembers.map((member) =>
          member.id === editingMemberId ? { ...member, ...editedData } : member
        )
      );

      setGroups((prevGroups) =>
        prevGroups.map((group) => {
          const updateMember = (member) =>
            member.id === editingMemberId ? { ...member, ...editedData } : member;

          return {
            ...group,
            waitingMembers: group.waitingMembers.map(updateMember),
            courts: group.courts.map((court) => {
              if (!court) return court;

              return {
                ...court,
                teamA: court.teamA.map(updateMember),
                teamB: court.teamB.map(updateMember),
              };
            }),
          };
        })
      );

      closeEditMember();
    } catch (error) {
      setEditDuplicateNicknameError("メンバー編集に失敗しました");
    }
  };

  const deleteEditingMember = async () => {
    if (!currentCircle) return;
    if (!editingMemberId) return;

    if (selectedIds.has(editingMemberId)) {
      setEditDeleteError("試合に出ているため削除できません");
      return;
    }

    const target = members.find((member) => member.id === editingMemberId);
    const confirmDelete = window.confirm(
      `${target?.nickname || target?.name || "このメンバー"}を削除しますか？`
    );

    if (!confirmDelete) return;

    try {
      await deleteMemberFromFirestore(currentCircle.circleId, editingMemberId);

      setMembers(members.filter((member) => member.id !== editingMemberId));

      setGroups((prevGroups) =>
        prevGroups.map((group) => ({
          ...group,
          waitingMembers: group.waitingMembers.filter(
            (member) => member.id !== editingMemberId
          ),
        }))
      );

      setTempSelectedIds((prevIds) =>
        prevIds.filter((id) => id !== editingMemberId)
      );
      closeEditMember();
    } catch (error) {
      setEditDeleteError("メンバー削除に失敗しました");
    }
  };
  const handleSwapTap = async (member, location) => {
    if (!member) return;
    if (isCourtSwapMode) return;

    if (!selectedSwap) {
      updateActiveGroup({ selectedSwap: { member, location } });
      return;
    }

    if (selectedSwap.member.id === member.id) {
      updateActiveGroup({ selectedSwap: null });
      return;
    }

    const nextWaitingMembers = [...waitingMembers];
    const nextCourts = courts.map((court) =>
      court
        ? {
            ...court,
            teamA: [...court.teamA],
            teamB: [...court.teamB],
          }
        : court
    );

    const setMemberAtLocation = (targetLocation, newMember) => {
      if (targetLocation.type === "waiting") {
        nextWaitingMembers[targetLocation.index] = newMember;
      }

      if (targetLocation.type === "court") {
        const targetCourt = nextCourts[targetLocation.courtIndex];
        if (!targetCourt) return;

        if (targetLocation.team === "A") {
          targetCourt.teamA[targetLocation.memberIndex] = newMember;
        }

        if (targetLocation.team === "B") {
          targetCourt.teamB[targetLocation.memberIndex] = newMember;
        }
      }
    };

    setMemberAtLocation(selectedSwap.location, member);
    setMemberAtLocation(location, selectedSwap.member);

    const nextGroups = groups.map((group) => {
      if (group.id !== activeGroupId) return group;

      return {
        ...group,
        waitingMembers: nextWaitingMembers,
        courts: nextCourts,
        selectedSwap: null,
      };
    });

    setGroups(nextGroups);
    await saveGroupsToFirestore(nextGroups, activeGroupId);
  };

  const isSwapSelected = (member) => {
    return selectedSwap?.member?.id === member.id;
  };

  // コート入れ替え1：試合内容をコート単位で丸ごと入れ替える。空きコートとの移動も可能。
  const toggleCourtSwapMode = () => {
    setIsCourtSwapMode((prev) => {
      const next = !prev;
      if (!next) setSelectedCourtSwapIndex(null);
      return next;
    });
  };

  const selectCourtForSwap = async (index) => {
    if (!activeGroup || isSyncSaving) return;

    if (selectedCourtSwapIndex === null) {
      setSelectedCourtSwapIndex(index);
      return;
    }

    if (selectedCourtSwapIndex === index) {
      setSelectedCourtSwapIndex(null);
      return;
    }

    const firstIndex = selectedCourtSwapIndex;
    const nextCourts = [...courts];
    const firstCourt = nextCourts[firstIndex] ?? null;
    nextCourts[firstIndex] = nextCourts[index] ?? null;
    nextCourts[index] = firstCourt;

    const nextGroups = groups.map((group) => {
      if (group.id !== activeGroupId) return group;

      return {
        ...group,
        courts: nextCourts,
        selectedSwap: null,
      };
    });

    setGroups(nextGroups);
    setSelectedCourtSwapIndex(null);
    setIsCourtSwapMode(false);

    const saved = await saveGroupsToFirestore(nextGroups, activeGroupId, {
      successMessage: `コート${getCircledNumber(firstIndex + 1)}とコート${getCircledNumber(index + 1)}を入れ替えました`,
    });

    if (!saved) {
      setSyncMessage("コート入れ替えが他端末の更新と重なりました。最新状態を確認してください");
    }
  };

  const generateCourt = async (index) => {
    let availableMembers = [...waitingMembers];

    if (courts[index]) {
      availableMembers = [
        ...availableMembers,
        ...courts[index].teamA,
        ...courts[index].teamB,
      ];
    }

    if (availableMembers.length < 4) return;

    const game = makeBestGame(
      availableMembers,
      pairHistory,
      opponentHistory,
      relationshipHistory,
      courtGroupHistory,
      playCounts,
      playCountSpreadLimit
    );

    if (!game) return;

    const usedIds = new Set([...game.teamA, ...game.teamB].map((m) => m.id));

    const newCourts = [...courts];
    newCourts[index] = {
      ...game,
      winner: null,
      gameId: createCourtGameId(activeGroupId, index),
      createdAtMillis: Date.now(),
    };

    const nextPairHistory = { ...pairHistory };
    game.pairKeys.forEach((key) => {
      nextPairHistory[key] = (nextPairHistory[key] || 0) + 1;
    });

    const nextOpponentHistory = { ...opponentHistory };
    game.opponentKeys.forEach((key) => {
      nextOpponentHistory[key] = (nextOpponentHistory[key] || 0) + 1;
    });

    const nextRelationshipHistory = { ...relationshipHistory };
    game.relationshipKeys.forEach((key) => {
      nextRelationshipHistory[key] = (nextRelationshipHistory[key] || 0) + 1;
    });

    const nextCourtGroupHistory = { ...courtGroupHistory };
    if (game.courtGroupKey) {
      nextCourtGroupHistory[game.courtGroupKey] =
        (nextCourtGroupHistory[game.courtGroupKey] || 0) + 1;
    }

    const nextGroups = groups.map((group) => {
      if (group.id !== activeGroupId) return group;

      return {
        ...group,
        courts: newCourts,
        waitingMembers: availableMembers.filter((m) => !usedIds.has(m.id)),
        pairHistory: nextPairHistory,
        opponentHistory: nextOpponentHistory,
        relationshipHistory: nextRelationshipHistory,
        courtGroupHistory: nextCourtGroupHistory,
        selectedSwap: null,
      };
    });

    setGroups(nextGroups);

    await saveGroupsToFirestore(nextGroups, activeGroupId);
  };

  const clearCourt = async (index) => {
    if (!courts[index]) return;

    const courtMembers = [...courts[index].teamA, ...courts[index].teamB];
    const newCourts = [...courts];
    newCourts[index] = null;

    const nextGroups = groups.map((group) => {
      if (group.id !== activeGroupId) return group;

      return {
        ...group,
        courts: newCourts,
        waitingMembers: [...waitingMembers, ...courtMembers],
        selectedSwap: null,
      };
    });

    setGroups(nextGroups);

    await saveGroupsToFirestore(nextGroups, activeGroupId);
  };

  const setWinner = (index, winner) => {
    const targetCourt = courts[index];
    if (!targetCourt) return;

    const newCourts = [...courts];
    newCourts[index] = {
      ...targetCourt,
      winner,
    };

    updateActiveGroup({
      courts: newCourts,
    });
  };

  const confirmCourtResult = async (index) => {
    if (!currentCircle || !activeGroup) return;

    const targetCourt = courts[index];
    if (!targetCourt || !targetCourt.winner) return;
    if (confirmingCourts[index]) return;

    setConfirmingCourts((prev) => ({ ...prev, [index]: true }));
    pendingSaveCountRef.current += 1;
    setIsSyncSaving(true);
    setAutoSyncStatus("試合結果を保存中");

    const localGameId = getStableCourtGameId(activeGroupId, index, targetCourt);
    const confirmedAtMillis = Date.now();

    try {
      const syncRef = getSyncDocRef(currentCircle.circleId);
      const historyRef = getGameResultDocRef(currentCircle.circleId, localGameId);

      const result = await runTransaction(db, async (transaction) => {
        const syncSnap = await transaction.get(syncRef);
        if (!syncSnap.exists()) {
          throw new Error("同期データが見つかりません");
        }

        const serverData = syncSnap.data();
        const serverGroups = Array.isArray(serverData.groups)
          ? serverData.groups
          : [];
        const serverGroup = serverGroups.find(
          (group) => group.id === activeGroupId
        );

        if (!serverGroup) {
          return { status: "stale", remoteData: serverData };
        }

        const serverCourt = serverGroup.courts?.[index];
        if (!serverCourt) {
          return { status: "stale", remoteData: serverData };
        }

        const serverGameId = getStableCourtGameId(
          activeGroupId,
          index,
          serverCourt
        );

        if (serverGameId !== localGameId) {
          return { status: "stale", remoteData: serverData };
        }

        const historySnap = await transaction.get(historyRef);
        if (historySnap.exists()) {
          return {
            status: "duplicate",
            remoteData: serverData,
            historyData: historySnap.data(),
          };
        }

        const allCourtMembers = [
          ...(serverCourt.teamA || []),
          ...(serverCourt.teamB || []),
        ];
        const uniqueMemberIds = Array.from(
          new Set(allCourtMembers.map((member) => member.id))
        );
        const memberRefs = uniqueMemberIds.map((memberId) =>
          getMemberDocRef(currentCircle.circleId, memberId)
        );
        const memberSnaps = await Promise.all(
          memberRefs.map((memberRef) => transaction.get(memberRef))
        );

        const latestMemberMap = new Map();
        memberSnaps.forEach((memberSnap, memberIndex) => {
          const memberId = uniqueMemberIds[memberIndex];
          if (!memberSnap.exists()) {
            throw new Error(`メンバー ${memberId} が見つかりません`);
          }
          latestMemberMap.set(memberId, {
            id: memberId,
            ...memberSnap.data(),
          });
        });

        const withLatestRate = (member) => {
          const latest = latestMemberMap.get(member.id);
          return latest ? { ...member, ...latest } : member;
        };

        // 勝者選択は確定ボタンを押すまでローカル表示のみなので、
        // serverCourt.winner ではなく、この端末で選択した勝者をtransactionへ渡す。
        const confirmedWinner = targetCourt.winner;
        const serverWinnerTeam =
          confirmedWinner === "A"
            ? serverCourt.teamA.map(withLatestRate)
            : serverCourt.teamB.map(withLatestRate);
        const serverLoserTeam =
          confirmedWinner === "A"
            ? serverCourt.teamB.map(withLatestRate)
            : serverCourt.teamA.map(withLatestRate);

        const rateMove = calculateRateMove(serverWinnerTeam, serverLoserTeam);
        const winnerIds = new Set(serverWinnerTeam.map((member) => member.id));
        const loserIds = new Set(serverLoserTeam.map((member) => member.id));
        const beforeRates = {};
        const afterRates = {};

        uniqueMemberIds.forEach((memberId) => {
          const member = latestMemberMap.get(memberId);
          const beforeRate = getMemberRate(member);
          beforeRates[memberId] = beforeRate;
          afterRates[memberId] = winnerIds.has(memberId)
            ? beforeRate + rateMove
            : beforeRate - rateMove;
        });

        const updateRateFromTransaction = (member) => {
          if (!Object.prototype.hasOwnProperty.call(afterRates, member.id)) {
            return member;
          }
          return {
            ...member,
            rate: afterRates[member.id],
          };
        };

        const nextServerGroups = serverGroups.map((group) => {
          const updatedWaitingMembers = (group.waitingMembers || []).map(
            updateRateFromTransaction
          );
          const updatedCourts = (group.courts || []).map((court, courtIndex) => {
            if (!court) return court;

            if (group.id === activeGroupId && courtIndex === index) {
              return null;
            }

            return {
              ...court,
              teamA: (court.teamA || []).map(updateRateFromTransaction),
              teamB: (court.teamB || []).map(updateRateFromTransaction),
            };
          });

          if (group.id !== activeGroupId) {
            return {
              ...group,
              waitingMembers: updatedWaitingMembers,
              courts: updatedCourts,
            };
          }

          const returnedCourtMembers = allCourtMembers.map((member) => {
            const latest = withLatestRate(member);
            return updateRateFromTransaction(latest);
          });
          const nextPlayCounts = { ...(group.playCounts || {}) };

          allCourtMembers.forEach((member) => {
            nextPlayCounts[member.id] = (nextPlayCounts[member.id] || 0) + 1;
          });

          return {
            ...group,
            waitingMembers: [...updatedWaitingMembers, ...returnedCourtMembers],
            courts: updatedCourts,
            playCounts: nextPlayCounts,
            selectedSwap: null,
          };
        });

        const remoteRevision = getSyncRevision(serverData);
        const nextRevision = remoteRevision + 1;
        const operationId = `${syncClientIdRef.current}-${confirmedAtMillis}-${Math.random()
          .toString(36)
          .slice(2)}`;

        // すべての読み込みが終わった後に、レート・試合終了・履歴を同じtransactionで書く。
        memberRefs.forEach((memberRef, memberIndex) => {
          const memberId = uniqueMemberIds[memberIndex];
          transaction.set(
            memberRef,
            {
              rate: afterRates[memberId],
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
        });

        const historyChanges = uniqueMemberIds.map((memberId) => {
          const member = latestMemberMap.get(memberId);
          return {
            memberId,
            nickname: member.nickname || member.name || "",
            beforeRate: beforeRates[memberId],
            afterRate: afterRates[memberId],
            change: afterRates[memberId] - beforeRates[memberId],
            result: winnerIds.has(memberId) ? "win" : "lose",
          };
        });

        transaction.set(historyRef, {
          gameId: localGameId,
          groupId: activeGroupId,
          groupName: serverGroup.groupName || "",
          courtNumber: index + 1,
          winner: confirmedWinner,
          rateMove,
          memberChanges: historyChanges,
          confirmedDevice: deviceTypeRef.current,
          confirmedBy: syncClientIdRef.current,
          confirmedAtMillis,
          confirmedAt: serverTimestamp(),
          practiceDate: serverData.practiceDate || getPracticeDateKey(),
        });

        transaction.set(syncRef, {
          ...serverData,
          groups: nextServerGroups,
          revision: nextRevision,
          baseRevision: remoteRevision,
          schemaVersion: Math.max(Number(serverData.schemaVersion || 2), 3),
          operationId,
          updatedAtMillis: confirmedAtMillis,
          updatedBy: syncClientIdRef.current,
          updatedDevice: deviceTypeRef.current,
          updatedAt: serverTimestamp(),
        });

        return {
          status: "saved",
          nextGroups: nextServerGroups,
          nextRevision,
          afterRates,
          rateMove,
        };
      });

      if (result.status === "duplicate") {
        if (result.remoteData) {
          applyRemoteSyncData(result.remoteData, {
            message: "この試合はすでに確定済みです。最新状態を反映しました",
            allowPracticePrompt: userMode !== "viewer",
          });
        }
        await refreshMembersFromServer(currentCircle.circleId);
        return;
      }

      if (result.status === "stale") {
        if (result.remoteData) {
          applyRemoteSyncData(result.remoteData, {
            message:
              "別端末で試合状態が更新されていたため、古い確定処理は中止しました",
            allowPracticePrompt: userMode !== "viewer",
          });
        }
        await refreshMembersFromServer(currentCircle.circleId);
        return;
      }

      setGroups(result.nextGroups);
      setMembers((prevMembers) =>
        prevMembers.map((member) =>
          Object.prototype.hasOwnProperty.call(result.afterRates, member.id)
            ? { ...member, rate: result.afterRates[member.id] }
            : member
        )
      );
      latestSyncVersionRef.current = result.nextRevision;
      syncInitializedRef.current = true;
      setLastSyncTime(formatSyncTime());
      setLastOperationDevice(deviceTypeRef.current);
      setLastOperationTime(formatOperationTime(confirmedAtMillis));
      setSyncMessage(
        `試合結果を確定しました（レート変動 ±${result.rateMove}）`
      );
      setAutoSyncStatus("自動同期中");
    } catch (error) {
      console.error("試合確定transaction失敗", error);
      setSyncMessage(
        "確定に失敗しました。通信とFirestoreルールを確認して、もう一度確定してください"
      );
    } finally {
      setConfirmingCourts((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });

      pendingSaveCountRef.current = Math.max(
        0,
        pendingSaveCountRef.current - 1
      );
      if (pendingSaveCountRef.current === 0) {
        setIsSyncSaving(false);
        applyPendingRemoteSyncIfNeeded();
      }
    }
  };

  const openViewerMemberSelect = () => {
    setViewerStep("selectMember");
    setViewerMemberSearch("");
  };

  const continueViewerToMain = () => {
    setViewerStep("done");

    if (groups.length > 0) {
      setActiveGroupId(activeGroupId || groups[0]?.id || null);
      setScreen("main");
    } else {
      setScreen("home");
    }
  };

  const saveViewerMember = async () => {
    if (!currentCircle) return;

    if (
      !viewerMemberForm.nickname.trim() ||
      !viewerMemberForm.reading.trim() ||
      !viewerMemberForm.gender ||
      !viewerMemberForm.rank
    ) {
      setViewerMemberFormError(true);
      return;
    }

    if (nicknameExists(viewerMemberForm.nickname)) {
      setViewerDuplicateNicknameError("同じニックネームがあります");
      return;
    }

    const newMember = {
      id: Date.now().toString(),
      nickname: viewerMemberForm.nickname.trim(),
      name: viewerMemberForm.nickname.trim(),
      reading: normalizeReadingInput(viewerMemberForm.reading.trim()),
      gender: viewerMemberForm.gender,
      rank: viewerMemberForm.rank,
      rate: getInitialRate(viewerMemberForm.rank),
    };

    try {
      await saveMemberToFirestore(currentCircle.circleId, newMember);

      setMembers((prevMembers) =>
        prevMembers.some((member) => member.id === newMember.id)
          ? prevMembers
          : [...prevMembers, newMember]
      );
      await refreshMembersFromServer(currentCircle.circleId);
      setViewerSelectedMemberId(newMember.id);
      setViewerMemberForm(emptyMemberForm);
      setViewerMemberFormError(false);
      setViewerDuplicateNicknameError("");
      continueViewerToMain();
    } catch (error) {
      setViewerDuplicateNicknameError("メンバー登録に失敗しました");
    }
  };

  const renderViewerConfirmScreen = () => {
    return (
      <div className="app homeScreen">
        <div className="circleHeader">
          <div>
            <div className="circleLabel">ログイン中</div>
            <strong>{currentCircle.circleName}</strong>
            <span className="viewerModeBadge">観賞用</span>
          </div>

          <div className="headerRightButtons">
            <button className="logoutButton" onClick={logoutCircle}>
              ログアウト
            </button>
          </div>
        </div>

        <section className="card viewerConfirmCard">
          <h1>確認</h1>

          <p className="viewerConfirmText">
            このサークルで活動したこと・組み合わせアプリのメンバーに入っていますか？
          </p>

          <div className="viewerConfirmActions">
            <button onClick={openViewerMemberSelect}>
              はい
            </button>

            <button
              className="subButton"
              onClick={() => {
                setViewerStep("register");
                setViewerMemberForm(emptyMemberForm);
                setViewerMemberFormError(false);
                setViewerDuplicateNicknameError("");
              }}
            >
              はじめてです・入っていないです
            </button>
          </div>
        </section>
      </div>
    );
  };

  const renderViewerRegisterScreen = () => {
    return (
      <div className="app">
        <div className="circleHeader">
          <div>
            <div className="circleLabel">ログイン中</div>
            <strong>{currentCircle.circleName}</strong>
            <span className="viewerModeBadge">観賞用</span>
          </div>

          <div className="headerRightButtons">
            <button className="logoutButton" onClick={logoutCircle}>
              ログアウト
            </button>
          </div>
        </div>

        <section className="card">
          <h1>メンバー新規登録</h1>

          {renderMemberForm({
            form: viewerMemberForm,
            setForm: setViewerMemberForm,
            formError: viewerMemberFormError,
            duplicateError: viewerDuplicateNicknameError,
            onSave: saveViewerMember,
            onClose: () => setViewerStep("confirm"),
            isEdit: false,
          })}
        </section>
      </div>
    );
  };


  const getViewerStatusText = () => {
    if (!viewerSelectedMember) {
      return "自分の名前が選択されていません";
    }

    for (let index = 0; index < courts.length; index++) {
      const court = courts[index];

      if (!court) continue;

      const isOnCourt = [...court.teamA, ...court.teamB].some(
        (member) => member.id === viewerSelectedMember.id
      );

      if (isOnCourt) {
        return `あなたは コート${getCircledNumber(index + 1)} で試合中です`;
      }
    }

    const isWaiting = waitingMembers.some(
      (member) => member.id === viewerSelectedMember.id
    );

    if (isWaiting) {
      return "あなたは休憩中です";
    }

    return "あなたは現在の参加メンバーには入っていません";
  };

  const renderViewerMemberSelectScreen = () => {
    return (
      <div className="app">
        <div className="circleHeader">
          <div>
            <div className="circleLabel">ログイン中</div>
            <strong>{currentCircle.circleName}</strong>
            <span className="viewerModeBadge">観賞用</span>
          </div>

          <div className="headerRightButtons">
            <button className="logoutButton" onClick={logoutCircle}>
              ログアウト
            </button>
          </div>
        </div>

        <section className="card">
          <h1>自分の名前を選択</h1>

          <p className="viewerConfirmText">
            観賞画面で自分の場所を分かりやすく表示します。
          </p>

          <input
            value={viewerMemberSearch}
            onChange={(e) => setViewerMemberSearch(e.target.value)}
            placeholder="検索：名前・読み方"
          />

          {renderGroupedMemberList({
            membersForList: filteredViewerMembers,
            refs: viewerGroupRefs,
            renderMember: (member) => (
              <button
                key={member.id}
                className={
                  viewerSelectedMemberId === member.id
                    ? "member selected"
                    : "member"
                }
                onClick={() => {
                  setViewerSelectedMemberId(member.id);
                  continueViewerToMain();
                }}
              >
                <strong>{member.nickname || member.name}</strong>
                {isReadingVisible && member.reading && (
                  <span className="memberReading">読み：{member.reading}</span>
                )}
                <span>レート：{getMemberRate(member)}</span>
              </button>
            ),
          })}

          <div className="bottomActions">
            <button className="subButton" onClick={continueViewerToMain}>
              選択せずに見る
            </button>
            <button className="subButton" onClick={() => setViewerStep("confirm")}>
              戻る
            </button>
          </div>
        </section>
      </div>
    );
  };


  const renderKanaJumpBar = (refs, membersForList) => {
    const existingKeys = new Set(membersForList.map(getKanaJumpGroupKey));

    return (
      <div className="kanaJumpBar">
        {kanaJumpGroups.map((group) => (
          <button
            key={group.key}
            type="button"
            className={
              existingKeys.has(group.key)
                ? "kanaJumpButton"
                : "kanaJumpButton disabledKanaJumpButton"
            }
            disabled={!existingKeys.has(group.key)}
            onClick={() => {
              refs.current[group.key]?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              });
            }}
          >
            {group.label}
          </button>
        ))}
      </div>
    );
  };

  const renderGroupedMemberList = ({
    membersForList,
    refs,
    renderMember,
  }) => {
    const grouped = membersForList.reduce((acc, member) => {
      const key = getKanaJumpGroupKey(member);

      if (!acc[key]) acc[key] = [];
      acc[key].push(member);

      return acc;
    }, {});

    return (
      <>
        {renderKanaJumpBar(refs, membersForList)}

        <div className="groupedMemberList">
          {kanaJumpGroups.map((group) => {
            const groupMembers = grouped[group.key] || [];

            if (groupMembers.length === 0) return null;

            return (
              <div
                key={group.key}
                ref={(element) => {
                  refs.current[group.key] = element;
                }}
                className="kanaGroupBlock"
              >
                <div className="kanaGroupTitle">{group.label}行</div>
                <div className="memberGrid modalMemberGrid">
                  {groupMembers.map(renderMember)}
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  };

  const renderImportMemberScreen = () => {
    return (
      <div className="app">
        <div className="circleHeader">
          <div>
            <div className="circleLabel">ログイン中</div>
            <strong>{currentCircle.circleName}</strong>
            {isViewerMode && (
              <span className="viewerModeBadge">観賞用</span>
            )}
          </div>

          <div className="headerRightButtons">
            <button className="logoutButton" onClick={logoutCircle}>
              ログアウト
            </button>
          </div>
        </div>

        <section className="card importScreenCard">
          <h1>別アカウントから持ってくる</h1>
          <p className="adminSmallNote">
            コピー元のサークルからメンバーを選んで登録します。レートはコピー元の現在値ではなく、ランク基準の初期レートで登録します。
          </p>

          <label>
            コピー元サークルID
            <input
              value={importCircleForm.circleId}
              onChange={(e) =>
                setImportCircleForm({
                  ...importCircleForm,
                  circleId: e.target.value,
                })
              }
              placeholder="コピー元のサークルID"
            />
          </label>

          <label>
            コピー元パスワード
            <input
              type="password"
              value={importCircleForm.password}
              onChange={(e) =>
                setImportCircleForm({
                  ...importCircleForm,
                  password: e.target.value,
                })
              }
              placeholder="通常または管理者パスワード"
            />
          </label>

          <div className="bottomActions">
            <button onClick={loadImportMembers} disabled={importLoading}>
              {importLoading ? "読み込み中..." : "メンバー読み込み"}
            </button>
            <button className="subButton" onClick={closeImportMemberScreen}>
              参加メンバー選択へ戻る
            </button>
          </div>

          {importError && (
            <p className="errorText centerText">{importError}</p>
          )}

          {importMembers.length > 0 && (
            <>
              <p className="participantCount">
                取込選択中：{importSelectedIds.length}人
              </p>

              <div className="importMemberGrid importScreenGrid">
                {importMembers.map((member) => {
                  const isImportSelected = importSelectedIds.includes(member.id);
                  const isDuplicate = nicknameExists(member.nickname || member.name || "");
                  const rank = member.rank || "初心者";
                  const baseRate =
                    typeof rankInitialRates?.[rank] === "number"
                      ? rankInitialRates[rank]
                      : getInitialRate(rank);

                  return (
                    <button
                      key={member.id}
                      className={
                        isImportSelected
                          ? "member selected importMemberCard"
                          : "member importMemberCard"
                      }
                      disabled={isDuplicate}
                      onClick={() => toggleImportMember(member.id)}
                    >
                      <strong>{member.nickname || member.name}</strong>
                      {isReadingVisible && member.reading && (
                        <span className="memberReading">読み：{member.reading}</span>
                      )}
                      <span>ランク：{rank}</span>
                      <span>登録時レート：{baseRate}</span>
                      {isDuplicate && (
                        <span className="duplicateImportText">
                          同じニックネームがあります
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              <button
                className="importDecisionButton"
                onClick={saveImportedMembers}
                disabled={importLoading}
              >
                選択したメンバーを登録
              </button>
            </>
          )}
        </section>
      </div>
    );
  };

  const renderViewerUrlAdminPanel = () => {
    const qrCodeUrl = buildQrCodeUrl(viewerUrl);

    return (
      <>
        <h3>閲覧用URL</h3>

        <p className="adminSmallNote viewerUrlNote">
          このQRコードを読み込むと、ログイン不要で観賞用画面を開けます。
          ただし、最初はこれまで通り「活動したことがありますか？」の確認画面から始まります。
        </p>

        {qrCodeUrl && (
          <div className="viewerQrBox">
            <img src={qrCodeUrl} alt="閲覧用URLのQRコード" />
          </div>
        )}

        <div className="viewerUrlText">
          {viewerUrl}
        </div>

        {viewerUrlCopyMessage && (
          <p className="syncMessage centerText">{viewerUrlCopyMessage}</p>
        )}

        <div className="bottomActions">
          <button className="viewerUrlCopyButton" onClick={copyViewerUrl}>
            URLコピー
          </button>
          <button
            className="subButton"
            onClick={() => {
              setViewerUrlCopyMessage("");
              setAdminPanel("menu");
            }}
          >
            戻る
          </button>
        </div>
      </>
    );
  };

  const renderPracticeDayPrompt = () => {
    if (!practiceDayPrompt || isViewerMode) return null;

    return (
      <div className="modalOverlay">
        <div className="modal practiceDayModal">
          <h2>前回の練習状態が残っています</h2>

          <p className="viewerConfirmText">
            午前4時を過ぎたため、新しい練習日として扱えます。
            前回のコート・参加状況を引き継ぐか、新しく練習を始めるか選んでください。
          </p>

          <div className="practiceDayInfo">
            <span>前回：{practiceDayPrompt.previousPracticeDate}</span>
            <span>今回：{practiceDayPrompt.todayPracticeDate}</span>
          </div>

          <div className="bottomActions">
            <button onClick={continuePreviousPracticeDay}>
              引き継ぐ
            </button>
            <button className="resetTodayButton" onClick={startNewPracticeDay}>
              新しく練習を始める
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderAuthScreen = () => {
    return (
      <div className="app authScreen">
        <div className="authCard">
          <h1>バドミントン組み合わせアプリ</h1>

          <div
            className={
              authMode === "login"
                ? "authModeTabs singleAuthModeTab"
                : "authModeTabs"
            }
          >
            {authMode === "create" && (
              <button
                className="authModeButton"
                onClick={() => {
                  setAuthMode("login");
                  setAuthError("");
                }}
              >
                ログインへ戻る
              </button>
            )}

            {authMode === "create" ? (
              <div className="authModeButton activeAuthMode">
                サークル作成
              </div>
            ) : (
              <button
                className="authModeButton"
                onClick={() => {
                  setAuthMode("create");
                  setAuthError("");
                }}
              >
                サークル作成
              </button>
            )}
          </div>

          {authMode === "login" ? (
            <>
              <label>
                サークルID
                <input
                  value={loginForm.circleId}
                  onChange={(e) =>
                    setLoginForm({ ...loginForm, circleId: e.target.value })
                  }
                  placeholder="例：osaka-badminton"
                />
              </label>

              <label>
                パスワード
                <input
                  type="password"
                  value={loginForm.password}
                  onChange={(e) =>
                    setLoginForm({ ...loginForm, password: e.target.value })
                  }
                  placeholder="通常または観賞用パスワード"
                />
              </label>

              {authError && <p className="errorText centerText">{authError}</p>}

              <button
                className="bigAuthButton"
                onClick={handleLoginCircle}
                disabled={authLoading}
              >
                {authLoading ? "確認中..." : "ログイン"}
              </button>
            </>
          ) : (
            <>
              <label>
                サークル名
                <input
                  value={createCircleForm.circleName}
                  onChange={(e) =>
                    setCreateCircleForm({
                      ...createCircleForm,
                      circleName: e.target.value,
                    })
                  }
                  placeholder="例：大阪バドミントンサークル"
                />
              </label>

              <label>
                サークルID
                <input
                  value={createCircleForm.circleId}
                  onChange={(e) =>
                    setCreateCircleForm({
                      ...createCircleForm,
                      circleId: e.target.value,
                    })
                  }
                  placeholder="例：osaka-badminton"
                />
                <span className="inputNoteRed">決定後は変更できません</span>
              </label>

              <label>
                ログイン用パスワード
                <input
                  type="password"
                  value={createCircleForm.password}
                  onChange={(e) =>
                    setCreateCircleForm({
                      ...createCircleForm,
                      password: e.target.value,
                    })
                  }
                  placeholder="通常ログイン用パスワード"
                />
                <span className="authInputNote">通常ログイン用のパスワードです</span>
              </label>

              <label>
                マスターパスワード
                <input
                  type="password"
                  value={createCircleForm.masterPassword}
                  onChange={(e) =>
                    setCreateCircleForm({
                      ...createCircleForm,
                      masterPassword: e.target.value,
                    })
                  }
                  placeholder="管理者設定用パスワード"
                />
                <span className="authInputNote">
                  メンバー削除、レート表示ON/OFF、個人または全体のレート調整などの管理者設定用パスワードです
                </span>
              </label>

              <label>
                メンバー登録・観賞用パスワード
                <input
                  type="password"
                  value={createCircleForm.viewerPassword}
                  onChange={(e) =>
                    setCreateCircleForm({
                      ...createCircleForm,
                      viewerPassword: e.target.value,
                    })
                  }
                  placeholder="参加者・観賞用パスワード"
                />
                <span className="authInputNote">
                  参加者がメンバー登録をしたり、参加や休憩を見るためのパスワードです
                </span>
              </label>

              <label>
                サークル作成キー
                <input
                  type="password"
                  value={createCircleForm.createKey}
                  onChange={(e) =>
                    setCreateCircleForm({
                      ...createCircleForm,
                      createKey: e.target.value,
                    })
                  }
                  placeholder="EYから共有されたキー"
                />
                <span className="authInputNote">
                  ※サークル作成の際は、必ずEYへご連絡ください
                </span>
              </label>

              {authError && <p className="errorText centerText">{authError}</p>}

              <button
                className="bigAuthButton"
                onClick={handleCreateCircle}
                disabled={authLoading}
              >
                {authLoading ? "作成中..." : "サークル作成"}
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  const renderPlayerButton = (member, location) => {
    const genderClass =
      member.gender === "男"
        ? "malePlayer"
        : member.gender === "女"
        ? "femalePlayer"
        : "";

    return (
      <button
        key={member.id}
        className={
          `${isSwapSelected(member) ? "playerChip selectedPlayerChip" : "playerChip"} ${genderClass} ${
            isViewerMode && viewerSelectedMemberId === member.id
              ? "viewerSelfChip"
              : ""
          }`
        }
        onClick={() => !isViewerMode && !isCourtSwapMode && handleSwapTap(member, location)}
      >
        <span>{member.nickname || member.name}</span>

        {isRateVisible && (
          <span className="playerRate">R{getMemberRate(member)}</span>
        )}

        {isPlayCountVisible && (
          <span className="playCountText">
            参加{playCounts[member.id] || 0}
          </span>
        )}
      </button>
    );
  };

  const renderCourt = (courtNumber) => {
    const index = courtNumber - 1;
    const court = courts[index];
    const isConfirming = Boolean(confirmingCourts[index]);
    const isSelectedForCourtSwap = selectedCourtSwapIndex === index;

    return (
      <div
        key={index}
        className={`courtVisual ${isSelectedForCourtSwap ? "courtSwapSelected" : ""}`}
      >
        {!isViewerMode && isCourtSwapMode && (
          <button
            className="courtSwapSelectButton"
            onClick={() => selectCourtForSwap(index)}
            disabled={isSyncSaving || isConfirming}
          >
            {isSelectedForCourtSwap
              ? `コート${getCircledNumber(courtNumber)} 選択中`
              : `コート${getCircledNumber(courtNumber)}を選択`}
          </button>
        )}

        {court ? (
          <div className="game">
            <div className={court.winner === "A" ? "teamBox teamBoxWin" : "teamBox"}>
              {court.winner === "A" && <div className="winText">WIN</div>}
              <div className="playerRow">
                {court.teamA.map((member, memberIndex) =>
                  renderPlayerButton(member, {
                    type: "court",
                    courtIndex: index,
                    team: "A",
                    memberIndex,
                  })
                )}
              </div>
              {!isViewerMode && (
                <button
                  className="winButton"
                  onClick={() => setWinner(index, "A")}
                  disabled={isConfirming || isSyncSaving || isCourtSwapMode}
                >
                  勝ち
                </button>
              )}
            </div>

            <div className="vs courtMiddleRow">
              <span>
                VS <span className="courtNumberBadge">{getCircledNumber(courtNumber)}</span>
              </span>

              {!isViewerMode && court.winner && (
                isConfirming ? (
                  <span className="confirmProcessingText">処理中…</span>
                ) : (
                  <button
                    className="inlineConfirmButton"
                    onClick={() => confirmCourtResult(index)}
                    disabled={isSyncSaving || isCourtSwapMode}
                  >
                    確定
                  </button>
                )
              )}
            </div>

            <div className={court.winner === "B" ? "teamBox teamBoxWin" : "teamBox"}>
              {court.winner === "B" && <div className="winText">WIN</div>}
              <div className="playerRow">
                {court.teamB.map((member, memberIndex) =>
                  renderPlayerButton(member, {
                    type: "court",
                    courtIndex: index,
                    team: "B",
                    memberIndex,
                  })
                )}
              </div>
              {!isViewerMode && (
                <button
                  className="winButton"
                  onClick={() => setWinner(index, "B")}
                  disabled={isConfirming || isSyncSaving || isCourtSwapMode}
                >
                  勝ち
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="emptyCourt">空き</div>
        )}

        {!isViewerMode && (
          <div className="row courtActionRow">
            {!court?.winner && (
              <button
                onClick={() => generateCourt(index)}
                disabled={isConfirming || isSyncSaving || isCourtSwapMode}
              >
                新規
              </button>
            )}
            <button
              className="subButton"
              onClick={() => clearCourt(index)}
              disabled={isConfirming || isSyncSaving || isCourtSwapMode}
            >
              消す
            </button>
          </div>
        )}
      </div>
    );
  };
  const renderMemberForm = ({
    form,
    setForm,
    formError,
    duplicateError,
    onSave,
    onClose,
    isEdit,
  }) => {
    return (
      <div className={`newMemberBox ${isEdit ? "editMode" : "registerMode"}`}>
        <h3>{isEdit ? "メンバー編集" : "メンバー新規登録"}</h3>

        <label>
          ニックネーム
          <input
            value={form.nickname}
            onChange={(e) =>
              updateFormNicknameWithAutoReading(form, setForm, e.target.value)
            }
            placeholder="例：田中 / タナカ / たなか"
          />
        </label>
        {formError && !form.nickname.trim() && (
          <p className="errorText">入力してください</p>
        )}

        <label>
          読み方
          <input
            value={form.reading}
            onChange={(e) =>
              setForm({
                ...form,
                reading: normalizeReadingInput(e.target.value),
              })
            }
            placeholder="ニックネームから自動入力されます"
          />
          <span className="readingAutoNote">
            カタカナは自動でひらがなに変換します。漢字は一般的な名字のみ候補を自動入力するため、必ず読み方を確認してください。
          </span>
        </label>
        {formError && !form.reading.trim() && (
          <p className="errorText">入力してください</p>
        )}

        <div className="formBlock">
          <div className="formTitle">性別</div>
          <div className="optionGrid">
            {genderOptions.map((gender) => (
              <button
                key={gender}
                onClick={() => setForm({ ...form, gender })}
                className={form.gender === gender ? "option selectedOption" : "option"}
              >
                {gender}
              </button>
            ))}
          </div>
          {formError && !form.gender && (
            <p className="errorText">選択してください</p>
          )}
        </div>

        {!isEdit && (
          <div className="formBlock">
            <div className="formTitle">ランク</div>
            <div className="rankGrid">
              {rankOptions.map((rank) => (
                <button
                  key={rank}
                  onClick={() => setForm({ ...form, rank })}
                  className={
                    form.rank === rank
                      ? "rankOption selectedRankOption"
                      : "rankOption"
                  }
                >
                  <span>{rank}</span>
                  <span className="rankRate">R{getInitialRate(rank)}</span>
                </button>
              ))}
            </div>
            {formError && !form.rank && (
              <p className="errorText">選択してください</p>
            )}
          </div>
        )}

        <div className={isEdit ? "bottomActions" : "registrationFormActions"}>
          <button
            className={isEdit ? "" : "primaryRegisterButton registerPulseButton"}
            onClick={onSave}
          >
            {isEdit ? "決定" : "この内容で登録"}
          </button>
          <button className="subButton" onClick={onClose}>
            {isEdit ? "もどる" : "閉じる"}
          </button>
        </div>

        {duplicateError && (
          <p className="errorText centerText">{duplicateError}</p>
        )}

        {isEdit && (
          <>
            <button
              className="deleteInEditButton"
              onClick={deleteEditingMember}
            >
              削除
            </button>

            {editDeleteError && (
              <p className="errorText centerText">{editDeleteError}</p>
            )}
          </>
        )}
      </div>
    );
  };

  const renderTabs = () => {
    if (groups.length === 0) return null;

    return (
      <div className="tabBar">
        <div className="tabScroll">
          {groups.map((group) => (
            <button
              key={group.id}
              className={
                group.id === activeGroupId ? "groupTab activeGroupTab" : "groupTab"
              }
              onClick={() => switchGroup(group.id)}
            >
              {group.groupName}
            </button>
          ))}

          {!isViewerMode && (
            <button className="addGroupTab" onClick={startCreateGroup}>
              グループを追加
            </button>
          )}
        </div>
      </div>
    );
  };

  if (!currentCircle) {
    return renderAuthScreen();
  }

  if (isViewerMode && viewerStep === "confirm") {
    return renderViewerConfirmScreen();
  }

  if (isViewerMode && viewerStep === "register") {
    return renderViewerRegisterScreen();
  }

  if (isViewerMode && viewerStep === "selectMember") {
    return renderViewerMemberSelectScreen();
  }

  if (screen === "importMembers") {
    return renderImportMemberScreen();
  }


  if (screen === "home") {
    return (
      <div className="app homeScreen">
        <div className="circleHeader">
          <div>
            <div className="circleLabel">ログイン中</div>
            <strong>{currentCircle.circleName}</strong>
            {isViewerMode && (
              <span className="viewerModeBadge">観賞用</span>
            )}
          </div>

          <div className="headerRightButtons">
            <button className="logoutButton" onClick={logoutCircle}>
              ログアウト
            </button>
          </div>
        </div>

        
        <p className="adminNoticeText">
          レート表示ON/OFFやメンバーの削除は管理者設定から行えます
        </p>

        <h1>バドミントン組み合わせアプリ</h1>

        {memberLoading && <p className="participantCount">メンバー読み込み中...</p>}

        {isViewerMode ? (
          <p className="viewerNotice">
            観賞用ログイン中です。組み合わせが作成されると自動で表示されます。
          </p>
        ) : (
          <button className="bigCreateButton" onClick={startCreateGroup}>
            新規作成
          </button>
        )}
      </div>
    );
  }

  if (screen === "create") {
    if (isViewerMode) {
      return (
        <div className="app homeScreen">
          <div className="circleHeader">
            <div>
              <div className="circleLabel">ログイン中</div>
              <strong>{currentCircle.circleName}</strong>
              <span className="viewerModeBadge">観賞用</span>
            </div>

            <div className="headerRightButtons">
              <button className="logoutButton" onClick={logoutCircle}>
                ログアウト
              </button>
            </div>
          </div>

          <p className="viewerNotice">
            観賞用ログイン中です。グループ作成はできません。
          </p>
        </div>
      );
    }

    return (
      <div className="app">
        <div className="circleHeader">
          <div>
            <div className="circleLabel">ログイン中</div>
            <strong>{currentCircle.circleName}</strong>
            {isViewerMode && (
              <span className="viewerModeBadge">観賞用</span>
            )}
          </div>

          <div className="headerRightButtons">
            <button className="logoutButton" onClick={logoutCircle}>
              ログアウト
            </button>
          </div>
        </div>

        
        <p className="adminNoticeText">
          レート表示ON/OFFやメンバーの削除は管理者設定から行えます
        </p>

        {renderTabs()}

        <h1>グループ作成</h1>

        <section className="card">
          <h2>名前</h2>
          <div className="optionGrid">
            {groupNameOptions.map((g) => (
              <button
                key={g}
                onClick={() => setCreateGroupName(g)}
                className={createGroupName === g ? "option selectedOption" : "option"}
              >
                {g}
              </button>
            ))}
          </div>
          {groupError && !createGroupName && (
            <p className="errorText">選択してください</p>
          )}
        </section>

        <section className="card">
          <h2>コート数</h2>
          <div className="numberGrid">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <button
                key={n}
                onClick={() => selectCourtCount(n)}
                className={
                  createCourtCount === String(n) ? "option selectedOption" : "option"
                }
              >
                {n}
              </button>
            ))}
          </div>
          {groupError && !createCourtCount && (
            <p className="errorText">選択してください</p>
          )}
        </section>

        {createCourtCount && (
          <section className="card">
            <h2>コート配置</h2>
            <div className="layoutOptionList">
              {currentLayouts.map((layout) => (
                <button
                  key={layout.id}
                  onClick={() => setCreateLayoutId(layout.id)}
                  className={
                    createLayoutId === layout.id
                      ? "layoutOption selectedLayoutOption"
                      : "layoutOption"
                  }
                >
                  <MiniLayout layout={layout} />
                </button>
              ))}
            </div>
            {groupError && !createLayoutId && (
              <p className="errorText">選択してください</p>
            )}
          </section>
        )}

        
        <section className="card">
          <h2>参加回数を表示しますか</h2>
          <div className="optionGrid">
            {rateDisplayOptions.map((option) => (
              <button
                key={option}
                onClick={() => setCreatePlayCountVisible(option)}
                className={
                  createPlayCountVisible === option
                    ? "option selectedOption"
                    : "option"
                }
              >
                {option}
              </button>
            ))}
          </div>
          {groupError && !createPlayCountVisible && (
            <p className="errorText">選択してください</p>
          )}
        </section>

        <section className="card">
          <h2>参加回数の差を何回まで許可しますか？</h2>
          <p className="pointRuleDescription">
            1回まで：かなり公平 / 2回まで：標準 / 3回まで：交流優先 / 気にしない：レート・ペア重複優先
          </p>
          <div className="playCountSpreadCreateGrid">
            {playCountSpreadOptions.map((option) => (
              <button
                key={option.label}
                onClick={() => setCreatePlayCountSpreadLimit(option.value)}
                className={
                  createPlayCountSpreadLimit === option.value
                    ? "playCountSpreadCreateOption selectedOption"
                    : "playCountSpreadCreateOption"
                }
              >
                <strong>{option.label}</strong>
                <span>{option.note}</span>
              </button>
            ))}
          </div>
          {groupError && !createPlayCountSpreadLimit && (
            <p className="errorText">選択してください</p>
          )}
        </section>

        <section className="card">
          <h2>何点制ですか</h2>
          <p className="pointRuleDescription">
            （これで途中参加の人の参加回数を調節します）
          </p>
          <div className="optionGrid">
            {["11点", "15点", "21点"].map((option) => (
              <button
                key={option}
                onClick={() => setCreatePointRule(option)}
                className={
                  createPointRule === option ? "option selectedOption" : "option"
                }
              >
                {option}
              </button>
            ))}
          </div>
          {groupError && !createPointRule && (
            <p className="errorText">選択してください</p>
          )}
        </section>

        {groupError && <p className="mainError">選ばれていません</p>}

        <div className="bottomActions">
          <button onClick={createGroup}>作成</button>
          <button
            className="subButton"
            onClick={() => {
              resetCreateForm();
              setScreen(groups.length > 0 ? "main" : "home");
            }}
          >
            戻る
          </button>
        </div>
      </div>
    );
  }

  if (!activeGroup) {
    return (
      <div className="app homeScreen">
        <div className="circleHeader">
          <div>
            <div className="circleLabel">ログイン中</div>
            <strong>{currentCircle.circleName}</strong>
            {isViewerMode && (
              <span className="viewerModeBadge">観賞用</span>
            )}
          </div>

          <div className="headerRightButtons">
{!isViewerMode && (
              <button
                className="adminSettingsButton"
                onClick={openAdminSettings}
              >
                管理者設定
              </button>
            )}

            <button className="logoutButton" onClick={logoutCircle}>
              ログアウト
            </button>
          </div>
        </div>

        
        <p className="adminNoticeText">
          レート表示ON/OFFやメンバーの削除は管理者設定から行えます
        </p>

        <h1>バドミントン組み合わせアプリ</h1>
        {isViewerMode ? (
          <p className="viewerNotice">
            観賞用ログイン中です。組み合わせが作成されると自動で表示されます。
          </p>
        ) : (
          <button className="bigCreateButton" onClick={startCreateGroup}>
            新規作成
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <div className="circleHeader">
          <div>
            <div className="circleLabel">ログイン中</div>
            <strong>{currentCircle.circleName}</strong>
            {isViewerMode && (
              <span className="viewerModeBadge">観賞用</span>
            )}
          </div>

          <div className="headerRightButtons">
{!isViewerMode && (
              <button
                className="adminSettingsButton"
                onClick={openAdminSettings}
              >
                管理者設定
              </button>
            )}

            <button className="logoutButton" onClick={logoutCircle}>
              ログアウト
            </button>
          </div>
        </div>

      
        <p className="adminNoticeText">
          レート表示ON/OFFやメンバーの削除は管理者設定から行えます
        </p>

        {renderTabs()}

      <div className="mainTitleRow">
        <h1>{activeGroup.groupName}</h1>

        {!isViewerMode && (
          <div className="mainTitleButtons">
            <button className="resetTodayButton largeResetButton" onClick={resetTodayState}>
              今日の練習を終える
              <br />
              <small>（新しく練習を始める）</small>
            </button>

            <button className="deleteGroupButton" onClick={deleteActiveGroup}>
              グループ削除
            </button>
          </div>
        )}
      </div>

      <section className="card">
        <div className="memberInfoRow">
          <h2>メンバー</h2>
          <p className="participantCountInline">参加中：{selectedIds.size}人</p>
        </div>

        {!isViewerMode && (
          <div className="memberHeaderButtons">
            <button
              className="participationMainButton"
              onClick={openParticipationModal}
            >
              参加
            </button>

            <button onClick={openCourtAddLayoutSelect}>
              コート追加
            </button>

            <button onClick={openCourtDeleteLayoutSelect}>
              コート削除
            </button>

            <button
              className={
                isCourtSwapMode
                  ? "courtSwapButton activeCourtSwapButton"
                  : "courtSwapButton"
              }
              onClick={toggleCourtSwapMode}
              disabled={isSyncSaving}
            >
              {isCourtSwapMode ? "入れ替えを終了" : "コート入れ替え"}
            </button>
          </div>
        )}

        {!isViewerMode && isCourtSwapMode && (
          <p className="courtSwapGuide">
            {selectedCourtSwapIndex === null
              ? "入れ替える1つ目のコートを選択してください（空きコートも選べます）"
              : `コート${getCircledNumber(selectedCourtSwapIndex + 1)}を選択中です。入れ替える2つ目のコートを選択してください`}
          </p>
        )}

        {isViewerMode && (
          <p className="viewerNoticeSmall">
            観賞用のため、操作ボタンは表示されません。
          </p>
        )}


        <div className="syncRow">
          <button
            className="syncButton"
            onClick={loadGroupsFromFirestore}
            disabled={isSyncSaving}
          >
            {isSyncSaving ? "保存中..." : "同期"}
          </button>
          <span className="syncStatus">
            {lastSyncTime ? `最終同期：${lastSyncTime}` : "未同期"}
          </span>
        </div>

        {lastOperationDevice && (
          <p className="lastOperationStatus">
            最終操作端末：{lastOperationDevice}
            {lastOperationTime ? `　最終更新：${lastOperationTime}` : ""}
          </p>
        )}

        {syncMessage && <p className="syncMessage">{syncMessage}</p>}
        {autoSyncStatus && <p className="autoSyncStatus">{autoSyncStatus}</p>}
      </section>

      {isViewerMode && (
        <section className="viewerStatusCard">
          <div>
            <div className="viewerStatusLabel">あなたの状態</div>
            <strong>
              {viewerSelectedMember
                ? viewerSelectedMember.nickname || viewerSelectedMember.name
                : "未選択"}
            </strong>
            <p>{getViewerStatusText()}</p>
          </div>

          <div className="viewerStatusActions">
            <button className="subButton" onClick={openViewerMemberSelect}>
              名前を変更
            </button>
            <button onClick={() => setIsViewerGuideOpen(true)}>
              ？
            </button>
          </div>
        </section>
      )}

      {shouldShowRotateMessage && (
        <p className="rotateScreenHint">
          横画面にすると見やすいです
        </p>
      )}

      <div
        className="courtGrid"
        style={{
          gridTemplateColumns: displayLayout
            ? `repeat(${displayLayout.columns}, 1fr)`
            : "repeat(2, 1fr)",
        }}
      >
        {displayLayout
          ? displayLayout.cells.map((cell, index) =>
              cell ? (
                renderCourt(cell)
              ) : (
                <div key={`blank-${index}`} className="courtBlank" />
              )
            )
          : courts.map((_, index) => renderCourt(index + 1))}
      </div>

      <section className="card">
  <div className="sectionHeader restSectionTitleRow">
    <h2>休憩</h2>

    {!isViewerMode && (
      <button className="playCountEditButton" onClick={openPlayCountModal}>
        参加回数変更
      </button>
    )}
  </div>

  {!isViewerMode && (
    <div className="restSwapText">
      タップして入れ替え
    </div>
  )}
        <div className="waitingList">
          {waitingMembers.map((member, index) => (
            <button
              key={member.id}
              className={
                `${isSwapSelected(member) ? "waitingChip selectedPlayerChip" : "waitingChip"} ${
                  isViewerMode && viewerSelectedMemberId === member.id
                    ? "viewerSelfChip"
                    : ""
                }`
              }
              onClick={() =>
                !isViewerMode &&
                !isCourtSwapMode &&
                handleSwapTap(member, {
                  type: "waiting",
                  index,
                })
              }
            >
              <span>{member.nickname || member.name}</span>
              {isRateVisible && (
                <span className="waitingRate">R{getMemberRate(member)}</span>
              )}
              {isPlayCountVisible && (
                <span className="playCountText">
                  参加{playCounts[member.id] || 0}
                </span>
              )}
            </button>
          ))}
        </div>
      </section>


      {renderPracticeDayPrompt()}

      {isViewerGuideOpen && (
        <div className="modalOverlay">
          <div className="modal">
            <h2>観賞用ガイド</h2>

            <div className="viewerGuideList">
              <p>・緑の枠はあなたの名前です</p>
              <p>・黄色は勝利ペアです</p>
              <p>・下の「休憩」にある名前は休憩中です</p>
              <p>・観賞用では、組み合わせや勝敗確定などの操作はできません</p>
            </div>

            <div className="bottomActions">
              <button onClick={() => setIsViewerGuideOpen(false)}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {isPlayCountModalOpen && (
        <div className="modalOverlay">
          <div className="modal">
            <h2>参加回数変更</h2>

            <div className="playCountSpreadModalBlock">
              <h3>参加回数の差を何回まで許可しますか？</h3>
              <p className="playCountSpreadModalDescription">
                1回まで：かなり公平 / 2回まで：標準 / 3回まで：交流優先 / 気にしない：レート・ペア重複優先
              </p>

              <div className="playCountSpreadModalGrid">
                {playCountSpreadOptions.map((option) => (
                  <button
                    key={option.label}
                    onClick={() => setTempPlayCountSpreadLimit(option.value)}
                    className={
                      tempPlayCountSpreadLimit === option.value
                        ? "playCountSpreadModalOption selectedOption"
                        : "playCountSpreadModalOption"
                    }
                  >
                    <strong>{option.label}</strong>
                    <span>{option.note}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="playCountEditGrid">
              {activePlayCountMembers.map((member) => (
                <div key={member.id} className="playCountEditCard">
                  <strong className="playCountEditName">
                    {member.nickname || member.name}
                  </strong>

                  <div className="playCountEditCount">
                    参加{tempPlayCounts[member.id] || 0}回
                  </div>

                  <div className="playCountEditActions">
                    <button
                      className="playCountNumberButton"
                      onClick={() => changeTempPlayCount(member.id, -1)}
                    >
                      −
                    </button>

                    <input
                      className="playCountValueInput"
                      type="number"
                      min="0"
                      value={tempPlayCounts[member.id] || 0}
                      onChange={(e) =>
                        setTempPlayCounts({
                          ...tempPlayCounts,
                          [member.id]: normalizePlayCountValue(e.target.value),
                        })
                      }
                    />

                    <button
                      className="playCountNumberButton"
                      onClick={() => changeTempPlayCount(member.id, 1)}
                    >
                      ＋
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="bottomActions">
              <button onClick={savePlayCounts}>決定</button>
              <button className="subButton" onClick={closePlayCountModal}>
                もどる
              </button>
            </div>
          </div>
        </div>
      )}

      {isAdminSettingsOpen && (
        <div className="modalOverlay">
          <div className="modal">
            <h2>管理者用設定</h2>

            {!adminUnlocked ? (
              <>
                <p className="adminNote">
                  管理者設定を変更するにはマスターパスワードを入力してください。
                </p>

                <label>
                  マスターパスワード
                  <input
                    type="password"
                    value={adminPasswordInput}
                    onChange={(e) => setAdminPasswordInput(e.target.value)}
                    placeholder="マスターパスワード"
                  />
                </label>

                {adminError && (
                  <p className="errorText centerText">{adminError}</p>
                )}

                <div className="bottomActions">
                  <button onClick={verifyAdminPassword}>確認</button>
                  <button className="subButton" onClick={closeAdminSettings}>
                    閉じる
                  </button>
                </div>
              </>
            ) : (
              <>
                {adminPanel === "menu" && (
                  <>
                    <p className="adminNote">
                      管理者メニューを選んでください。
                    </p>

                    <div className="adminMenuGrid">
                      <button
                        className="viewerUrlMenuButton"
                        onClick={() => {
                          setViewerUrlCopyMessage("");
                          setAdminPanel("viewerUrl");
                        }}
                      >
                        閲覧用URL
                      </button>

                      <button onClick={() => setAdminPanel("circleName")}>
                        サークル名変更
                      </button>

                      <button onClick={() => setAdminPanel("password")}>
                        パスワード変更
                      </button>

                      <button onClick={() => setAdminPanel("rateDisplay")}>
                        レート表示ON/OFF
                      </button>

                      <button onClick={() => setAdminPanel("readingDisplay")}>
                        読み仮名表示ON/OFF
                      </button>

                      <button onClick={() => setAdminPanel("member")}>
                        メンバー編集・削除・レート変更
                      </button>

                      <button onClick={() => setAdminPanel("rateBase")}>
                        レート変動値変更
                      </button>

                      <button onClick={() => setAdminPanel("rankRate")}>
                        ランク初期値変更
                      </button>

                      <button onClick={() => setAdminPanel("rateProfile")}>
                        レート名管理
                      </button>

                      <button
                        className="rateHistoryMenuButton"
                        onClick={() => {
                          setAdminPanel("rateHistory");
                          loadRateHistory();
                        }}
                      >
                        レート変更履歴
                      </button>

                      <button
                        className="resetRateButton"
                        onClick={resetAllRates}
                      >
                        レート初期化
                      </button>
                    </div>

                    <div className="bottomActions">
                      <button className="subButton" onClick={closeAdminSettings}>
                        閉じる
                      </button>
                    </div>
                  </>
                )}

                {adminPanel === "viewerUrl" && renderViewerUrlAdminPanel()}

                {adminPanel === "circleName" && (
                  <>
                    <h3>サークル名変更</h3>

                    <label>
                      サークル名
                      <input
                        value={adminSettingsForm.circleName}
                        onChange={(e) =>
                          setAdminSettingsForm({
                            ...adminSettingsForm,
                            circleName: e.target.value,
                          })
                        }
                        placeholder="サークル名"
                      />
                    </label>

                    {adminError && (
                      <p className="errorText centerText">{adminError}</p>
                    )}

                    <div className="bottomActions">
                      <button onClick={saveAdminSettings}>保存</button>
                      <button
                        className="subButton"
                        onClick={() => setAdminPanel("menu")}
                      >
                        戻る
                      </button>
                    </div>
                  </>
                )}

                {adminPanel === "password" && (
                  <>
                    <h3>パスワード変更</h3>

                    <label>
                      通常パスワード
                      <input
                        value={adminSettingsForm.password}
                        onChange={(e) =>
                          setAdminSettingsForm({
                            ...adminSettingsForm,
                            password: e.target.value,
                          })
                        }
                        placeholder="通常ログイン用パスワード"
                      />
                    </label>

                    <label>
                      管理者パスワード
                      <input
                        value={adminSettingsForm.masterPassword}
                        onChange={(e) =>
                          setAdminSettingsForm({
                            ...adminSettingsForm,
                            masterPassword: e.target.value,
                          })
                        }
                        placeholder="管理者用パスワード"
                      />
                    </label>

                    <label>
                      観賞用パスワード
                      <input
                        value={adminSettingsForm.viewerPassword}
                        onChange={(e) =>
                          setAdminSettingsForm({
                            ...adminSettingsForm,
                            viewerPassword: e.target.value,
                          })
                        }
                        placeholder="未設定でもOK"
                      />
                      <span className="adminSmallNote">
                        観賞モード実装時に使用します
                      </span>
                    </label>

                    {adminError && (
                      <p className="errorText centerText">{adminError}</p>
                    )}

                    <div className="bottomActions">
                      <button onClick={saveAdminSettings}>保存</button>
                      <button
                        className="subButton"
                        onClick={() => setAdminPanel("menu")}
                      >
                        戻る
                      </button>
                    </div>
                  </>
                )}

                {adminPanel === "rateDisplay" && (
                  <>
                    <h3>レート表示ON/OFF</h3>

                    <div className="formBlock">
                      <div className="formTitle">レートを表示しますか</div>
                      <div className="optionGrid">
                        {rateDisplayOptions.map((option) => (
                          <button
                            key={option}
                            onClick={() =>
                              setAdminSettingsForm({
                                ...adminSettingsForm,
                                defaultRateDisplay: option,
                              })
                            }
                            className={
                              adminSettingsForm.defaultRateDisplay === option
                                ? "option selectedOption"
                                : "option"
                            }
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </div>

                    <p className="adminSmallNote">
                      今後の管理者設定・観賞モードで使う全体設定です。
                    </p>

                    {adminError && (
                      <p className="errorText centerText">{adminError}</p>
                    )}

                    <div className="bottomActions">
                      <button onClick={saveAdminSettings}>保存</button>
                      <button
                        className="subButton"
                        onClick={() => setAdminPanel("menu")}
                      >
                        戻る
                      </button>
                    </div>
                  </>
                )}


                {adminPanel === "readingDisplay" && (
                  <>
                    <h3>読み仮名表示ON/OFF</h3>

                    <div className="formBlock">
                      <div className="formTitle">読み仮名を表示しますか</div>
                      <div className="optionGrid">
                        {rateDisplayOptions.map((option) => (
                          <button
                            key={option}
                            onClick={() =>
                              setAdminSettingsForm({
                                ...adminSettingsForm,
                                defaultReadingDisplay: option,
                              })
                            }
                            className={
                              adminSettingsForm.defaultReadingDisplay === option
                                ? "option selectedOption"
                                : "option"
                            }
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </div>

                    <p className="adminSmallNote">
                      メンバー一覧や参加者選択画面に読み仮名を表示するかを切り替えます。入力欄はOFFでも残ります。
                    </p>

                    {adminError && (
                      <p className="errorText centerText">{adminError}</p>
                    )}

                    <div className="bottomActions">
                      <button onClick={saveAdminSettings}>保存</button>
                      <button
                        className="subButton"
                        onClick={() => setAdminPanel("menu")}
                      >
                        戻る
                      </button>
                    </div>
                  </>
                )}

                
                {adminPanel === "rateBase" && (
                  <>
                    <h3>レート変動値変更</h3>

                    <p className="adminSmallNote">
                      現在の基本変動値：{rateChangeBase}
                    </p>

                    <div className="optionGrid">
                      {[20, 40, 60, 80, 100].map((value) => (
                        <button
                          key={value}
                          onClick={() => setRateChangeBase(value)}
                          className={
                            rateChangeBase === value
                              ? "option selectedOption"
                              : "option"
                          }
                        >
                          {value}
                        </button>
                      ))}
                    </div>

                    <button
                      className="resetSettingButton"
                      onClick={() => setRateChangeBase(DEFAULT_RATE_CHANGE_BASE)}
                    >
                      初期値に戻す
                    </button>

                    <div className="bottomActions">
                      <button onClick={saveAdminSettings}>
                        保存
                      </button>

                      <button
                        className="subButton"
                        onClick={() => setAdminPanel("menu")}
                      >
                        戻る
                      </button>
                    </div>
                  </>
                )}

                {adminPanel === "rankRate" && (
                  <>
                    <h3>ランク初期値変更</h3>

                    <div className="adminRankRateList">
                      {Object.entries(rankInitialRates).map(([rank, rate]) => (
                        <label key={rank} className="adminRankRateItem">
                          <span>{rank}</span>

                          <input
                            type="number"
                            value={rate}
                            onChange={(e) =>
                              setRankInitialRates({
                                ...rankInitialRates,
                                [rank]: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                      ))}
                    </div>

                    <button
                      className="resetSettingButton"
                      onClick={() => setRankInitialRates(DEFAULT_RANK_INITIAL_RATES)}
                    >
                      初期値に戻す
                    </button>

                    <div className="bottomActions">
                      <button onClick={saveAdminSettings}>
                        保存
                      </button>

                      <button
                        className="subButton"
                        onClick={() => setAdminPanel("menu")}
                      >
                        戻る
                      </button>
                    </div>
                  </>
                )}

                {adminPanel === "rateProfile" && (
                  <>
                    <h3>レート名管理</h3>

                    <p className="adminSmallNote">
                      例：通常 / 初級 / 上級 など
                    </p>

                    <div className="adminRateProfileList">
                      {rateProfiles.map((profile, index) => (
                        <input
                          key={index}
                          value={profile}
                          onChange={(e) => {
                            const next = [...rateProfiles];
                            next[index] = e.target.value;
                            setRateProfiles(next);
                          }}
                        />
                      ))}
                    </div>

                    <div className="bottomActions">
                      <button onClick={saveAdminSettings}>
                        保存
                      </button>

                      <button
                        className="subButton"
                        onClick={() => setAdminPanel("menu")}
                      >
                        戻る
                      </button>
                    </div>
                  </>
                )}

                {adminPanel === "rateHistory" && (
                  <>
                    <h3>レート変更履歴</h3>
                    <p className="adminSmallNote">
                      直近50試合の確定履歴です。同じ試合IDは1回だけレートへ反映されます。
                    </p>

                    <button
                      className="rateHistoryReloadButton"
                      onClick={loadRateHistory}
                      disabled={rateHistoryLoading}
                    >
                      {rateHistoryLoading ? "読み込み中…" : "履歴を再読み込み"}
                    </button>

                    {rateHistoryError && (
                      <p className="errorText centerText">{rateHistoryError}</p>
                    )}

                    <div className="rateHistoryList">
                      {rateHistoryItems.map((item) => (
                        <div key={item.id} className="rateHistoryCard">
                          <div className="rateHistoryHeader">
                            <strong>{item.groupName || "グループ"}</strong>
                            <span>コート{item.courtNumber || "-"}</span>
                          </div>
                          <div className="rateHistoryMeta">
                            {item.confirmedAtMillis
                              ? new Date(item.confirmedAtMillis).toLocaleString("ja-JP")
                              : "日時不明"}
                            {item.confirmedDevice
                              ? ` / ${item.confirmedDevice}`
                              : ""}
                          </div>
                          <div className="rateHistoryGameId">
                            試合ID：{item.gameId || item.id}
                          </div>
                          <div className="rateHistoryChanges">
                            {(item.memberChanges || []).map((change) => (
                              <div
                                key={`${item.id}-${change.memberId}`}
                                className="rateHistoryChangeRow"
                              >
                                <span>{change.nickname || change.memberId}</span>
                                <span>
                                  {change.beforeRate} → {change.afterRate}
                                  {change.change >= 0 ? " +" : " "}
                                  {change.change}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}

                      {!rateHistoryLoading && rateHistoryItems.length === 0 && !rateHistoryError && (
                        <p className="adminSmallNote">まだ確定履歴はありません。</p>
                      )}
                    </div>

                    <div className="bottomActions">
                      <button
                        className="subButton"
                        onClick={() => setAdminPanel("menu")}
                      >
                        戻る
                      </button>
                    </div>
                  </>
                )}

{adminPanel === "member" && (
                  <>
                    <h3>メンバー編集・削除・レート変更</h3>

                    <p className="adminSmallNote">
                      メンバーを選ぶと、名前・読み方・性別・ランク・レートを変更できます。
                    </p>

                    {renderGroupedMemberList({
                      membersForList: sortedMembers,
                      refs: adminGroupRefs,
                      renderMember: (member) => (
                        <button
                          key={member.id}
                          className="member"
                          onClick={() => openAdminMemberEdit(member)}
                        >
                          <strong>{member.nickname || member.name}</strong>
                          {isReadingVisible && member.reading && (
                            <span className="memberReading">読み：{member.reading}</span>
                          )}
                          <span>ランク：{member.rank || "未設定"}</span>
                          <span>レート：{getMemberRate(member)}</span>
                        </button>
                      ),
                    })}

                    <div className="bottomActions">
                      <button
                        className="subButton"
                        onClick={() => setAdminPanel("menu")}
                      >
                        戻る
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {selectedAdminMember && (
        <div className="modalOverlay">
          <div className="modal">
            <h2>メンバー編集・削除</h2>

            <label>
              ニックネーム
              <input
                value={adminMemberEditForm.nickname}
                onChange={(e) =>
                  updateFormNicknameWithAutoReading(
                    adminMemberEditForm,
                    setAdminMemberEditForm,
                    e.target.value
                  )
                }
              />
            </label>

            <label>
              読み方
              <input
                value={adminMemberEditForm.reading}
                onChange={(e) =>
                  setAdminMemberEditForm({
                    ...adminMemberEditForm,
                    reading: normalizeReadingInput(e.target.value),
                  })
                }
              />
              <span className="readingAutoNote">
                カタカナはひらがなへ自動変換します。漢字は読み方欄には入力できません。
              </span>
            </label>

            <div className="formBlock">
              <div className="formTitle">性別</div>
              <div className="optionGrid">
                {genderOptions.map((gender) => (
                  <button
                    key={gender}
                    onClick={() =>
                      setAdminMemberEditForm({
                        ...adminMemberEditForm,
                        gender,
                      })
                    }
                    className={
                      adminMemberEditForm.gender === gender
                        ? "option selectedOption"
                        : "option"
                    }
                  >
                    {gender}
                  </button>
                ))}
              </div>
            </div>

            <div className="formBlock">
              <div className="formTitle">ランク</div>
              <div className="rankGrid">
                {rankOptions.map((rank) => (
                  <button
                    key={rank}
                    onClick={() =>
                      setAdminMemberEditForm({
                        ...adminMemberEditForm,
                        rank,
                      })
                    }
                    className={
                      adminMemberEditForm.rank === rank
                        ? "rankOption selectedRankOption"
                        : "rankOption"
                    }
                  >
                    <span>{rank}</span>
                    <span className="rankRate">初期R{getInitialRate(rank)}</span>
                  </button>
                ))}
              </div>
              <p className="adminSmallNote">
                ランクを変更しても、レートは自動変更されません。
              </p>
            </div>

            <label>
              レート
              <input
                type="number"
                value={adminMemberEditForm.rate}
                onChange={(e) =>
                  setAdminMemberEditForm({
                    ...adminMemberEditForm,
                    rate: e.target.value,
                  })
                }
              />
            </label>
{adminMemberEditError && (
              <p className="errorText centerText">{adminMemberEditError}</p>
            )}

            <div className="bottomActions">
              <button onClick={saveAdminMemberEdit}>保存</button>
              <button className="subButton" onClick={() => { closeAdminMemberEdit(); setAdminPanel("menu"); }}>
                戻る
              </button>
            </div>

            <button className="deleteInEditButton" onClick={deleteAdminMember}>
              削除
            </button>
          </div>
        </div>
      )}

      {layoutChangeMode && pendingCourtCount && (
        <div className="modalOverlay">
          <div className="modal">
            <h2>
              {pendingCourtCount}コートの配置を選択
            </h2>

            <div className="layoutOptionList">
              {(layoutOptions[Number(pendingCourtCount)] || []).map((layout) => (
                <button
                  key={layout.id}
                  onClick={() => applyCourtLayoutChange(layout.id)}
                  className="layoutOption"
                >
                  <MiniLayout layout={layout} />
                </button>
              ))}
            </div>

            <div className="bottomActions">
              <button
                className="subButton"
                onClick={() => {
                  setLayoutChangeMode(null);
                  setPendingCourtCount("");
                }}
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {isParticipationModalOpen && (
        <div className="modalOverlay">
          <div className="modal">
            <h2>参加メンバー選択</h2>

            <input
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder="検索：名前・読み方"
            />

            <p className="participantCount">
              選択中：{tempSelectedIds.length}人
            </p>

            {participationError && (
              <p className="errorText centerText">{participationError}</p>
            )}

            <div className="participationActions">
              <button
                className="newMemberOpenButton"
                onClick={() => {
                  setIsNewMemberFormOpen(!isNewMemberFormOpen);
                  setIsEditSelectMode(false);
                  setRegistrationSuccessMessage("");
                }}
              >
                ＋ 新規メンバー登録
              </button>

              <button
                className={
                  isEditSelectMode
                    ? "memberEditModeButton activeMemberEditModeButton"
                    : "memberEditModeButton"
                }
                onClick={() => {
                  setIsEditSelectMode(!isEditSelectMode);
                  setIsNewMemberFormOpen(false);
                  setEditingMemberId(null);
                  setIsImportMemberModalOpen(false);
                }}
              >
                編集
              </button>

              <button
                className="importMemberButton"
                onClick={openImportMemberModal}
              >
                別アカウントから持ってくる
              </button>
            </div>

            {registrationSuccessMessage && (
              <p className="registrationSuccessMessage">
                {registrationSuccessMessage}
              </p>
            )}

            {isEditSelectMode && (
              <p className="editSelectGuide">編集するメンバーを選んでください</p>
            )}

            {isNewMemberFormOpen &&
              renderMemberForm({
                form: memberForm,
                setForm: setMemberForm,
                formError: memberFormError,
                duplicateError: duplicateNicknameError,
                onSave: saveMember,
                onClose: () => {
                  setIsNewMemberFormOpen(false);
                  setMemberForm(emptyMemberForm);
                  setMemberFormError(false);
                  setDuplicateNicknameError("");
                },
                isEdit: false,
              })}

            {editingMemberId &&
              renderMemberForm({
                form: editMemberForm,
                setForm: setEditMemberForm,
                formError: editMemberFormError,
                duplicateError: editDuplicateNicknameError,
                onSave: saveEditedMember,
                onClose: closeEditMember,
                isEdit: true,
              })}

            {memberLoading ? (
              <div className="memberLoadingBox">
                メンバー読み込み中…
              </div>
            ) : (
              <>
                <p className="memberListCount">
                  登録メンバー：{members.length}人 / 表示中：{filteredMembers.length}人
                </p>
                {renderGroupedMemberList({
              membersForList: filteredMembers,
              refs: participationGroupRefs,
              renderMember: (member) => {
                const isSelected = tempSelectedIds.includes(member.id);
                const isOnCourt = onCourtIds.has(member.id);

                return (
                  <button
                    key={member.id}
                    onClick={() => {
                      if (isEditSelectMode) {
                        openEditMember(member);
                        setIsEditSelectMode(false);
                        return;
                      }

                      toggleTempMember(member);
                    }}
                    className={
                      isSelected
                        ? "member selected modalMember"
                        : "member modalMember"
                    }
                  >
                    <strong>{member.nickname || member.name}</strong>
                    {isReadingVisible && member.reading && (
                      <span className="memberReading">読み：{member.reading}</span>
                    )}
                    {isRateVisible && (
                      <div className="memberRateRow">
                        <span className="memberRate">R{getMemberRate(member)}</span>
                        {isOnCourt && <span className="onCourtLabel">試合中</span>}
                      </div>
                    )}

                    {!isRateVisible && isOnCourt && (
                      <span className="onCourtLabel">試合中</span>
                    )}
                  </button>
                );
              },
            })}
              </>
            )}

            <div className="bottomActions participationStickyActions">
              <button
                className="participationDecisionButton"
                onClick={decideParticipation}
                disabled={memberLoading}
              >
                決定
              </button>
              <button className="subButton" onClick={closeParticipationModal}>
                もどる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
