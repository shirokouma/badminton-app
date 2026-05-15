import React, { useEffect, useMemo, useState } from "react";
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

function makeBestGame(
  waitingMembers,
  pairHistory,
  opponentHistory,
  relationshipHistory,
  playCounts
) {
  if (waitingMembers.length < 4) return null;

  const sortedByPlayCount = shuffle(waitingMembers).sort(
    (a, b) => (playCounts[a.id] || 0) - (playCounts[b.id] || 0)
  );

  const candidates = sortedByPlayCount.slice(0, Math.min(12, sortedByPlayCount.length));
  const lowestPlayCount = Math.min(
    ...waitingMembers.map((member) => playCounts[member.id] || 0)
  );

  let best = null;

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      for (let k = j + 1; k < candidates.length; k++) {
        for (let l = k + 1; l < candidates.length; l++) {
          const group = [candidates[i], candidates[j], candidates[k], candidates[l]];

          const patterns = [
            [[0, 1], [2, 3]],
            [[0, 2], [1, 3]],
            [[0, 3], [1, 2]],
          ];

          for (const pattern of patterns) {
            const teamA = [group[pattern[0][0]], group[pattern[0][1]]];
            const teamB = [group[pattern[1][0]], group[pattern[1][1]]];

            const keyA = pairKey(teamA[0], teamA[1]);
            const keyB = pairKey(teamB[0], teamB[1]);

            const groupPlayCounts = group.map((member) => playCounts[member.id] || 0);
            const groupMaxPlayCount = Math.max(...groupPlayCounts);
            const groupMinPlayCount = Math.min(...groupPlayCounts);

            const lowPlayPriorityPenalty = group.reduce((sum, member) => {
              return sum + Math.max(0, (playCounts[member.id] || 0) - lowestPlayCount);
            }, 0);

            const playCountSpreadPenalty = Math.max(0, groupMaxPlayCount - groupMinPlayCount - 2);

            const allCourtPairs = getAllPairs(group);
            const relationshipPenalty = allCourtPairs.reduce(
              (sum, key) => sum + (relationshipHistory[key] || 0),
              0
            );

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

            const teamARate = teamA.reduce((sum, member) => sum + getMemberRate(member), 0);
            const teamBRate = teamB.reduce((sum, member) => sum + getMemberRate(member), 0);
            const rateDiffPenalty = Math.abs(teamARate - teamBRate);

            const score =
              lowPlayPriorityPenalty * 1000000 +
              playCountSpreadPenalty * 500000 +
              relationshipPenalty * 20000 +
              pairDuplicatePenalty * 10000 +
              opponentPenalty * 5000 +
              rateDiffPenalty +
              Math.random();

            if (!best || score < best.score) {
              best = {
                teamA,
                teamB,
                pairKeys: [keyA, keyB],
                opponentKeys: opponentPairs,
                relationshipKeys: allCourtPairs,
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

const STORAGE_KEY = "badminton_members_v1";

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

const rankOptions = [
  "バドミントンのルール知らない",
  "初心者",
  "基礎打ちができる",
  "ゲーム中打ち分けが出来る",
  "得意技がある",
  "中級",
  "上級",
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
  中級: 3300,
  上級: 3500,
  大会で1部2部で出たことがある: 3700,
  大会では1部の常連: 3900,
  全国経験あり: 4100,
};

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

  let move = 80;

  if (winnerTotal < loserTotal) {
    move = 80 + bonus;
  }

  if (winnerTotal > loserTotal) {
    move = 80 - bonus;
  }

  return clampRateMove(move);
}

function applyRateToMember(member, change) {
  return {
    ...member,
    rate: getMemberRate(member) + change,
  };
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
    { id: "five-left", columns: 4, cells: [1, 2, 3, 4, 5, null, null, null] },
    { id: "five-right", columns: 4, cells: [1, 2, 3, 4, null, null, null, 5] },
    { id: "five-3-2", columns: 3, cells: [1, 2, 3, 4, 5, null] },
    { id: "five-2-3", columns: 3, cells: [1, 2, null, 3, 4, 5] },
    { id: "five-u", columns: 3, cells: [1, 2, 3, 4, null, 5] },
  ],
  6: [
    { id: "six-3-2", columns: 3, cells: [1, 2, 3, 4, 5, 6] },
    { id: "six-left", columns: 4, cells: [1, 2, 3, 4, 5, 6, null, null] },
    { id: "six-right", columns: 4, cells: [1, 2, 3, 4, null, null, 5, 6] },
    { id: "six-center", columns: 4, cells: [1, 2, 3, 4, null, 5, 6, null] },
  ],
  7: [
    { id: "seven-left", columns: 4, cells: [1, 2, 3, 4, 5, 6, 7, null] },
    { id: "seven-right", columns: 4, cells: [1, 2, 3, 4, null, 5, 6, 7] },
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

function createGroupObject({ groupName, courtCount, layoutId, rateDisplay }) {
  return {
    id: Date.now().toString(),
    groupName,
    courtCount,
    layoutId,
    rateDisplay,
    createdAt: Date.now(),
    waitingMembers: [],
    courts: Array.from({ length: Number(courtCount) }, () => null),
    pairHistory: {},
    opponentHistory: {},
    relationshipHistory: {},
    playCounts: {},
    selectedSwap: null,
  };
}

function getInitialPlayCountForGroup(group) {
  if (!group?.createdAt) return 0;

  const elapsed = Date.now() - group.createdAt;
  const twentyFiveMinutes = 25 * 60 * 1000;

  return Math.floor(elapsed / twentyFiveMinutes);
}

export default function App() {
  const [screen, setScreen] = useState("home");

  const [members, setMembers] = useState(() => {
    const savedMembers = localStorage.getItem(STORAGE_KEY);
    if (!savedMembers) return [];

    try {
      return JSON.parse(savedMembers);
    } catch {
      return [];
    }
  });

  const [groups, setGroups] = useState([]);
  const [activeGroupId, setActiveGroupId] = useState(null);

  const [createGroupName, setCreateGroupName] = useState("");
  const [createCourtCount, setCreateCourtCount] = useState("");
  const [createLayoutId, setCreateLayoutId] = useState("");
  const [createRateDisplay, setCreateRateDisplay] = useState("");
  const [groupError, setGroupError] = useState(false);

  const [isParticipationModalOpen, setIsParticipationModalOpen] = useState(false);
  const [tempSelectedIds, setTempSelectedIds] = useState([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [isNewMemberFormOpen, setIsNewMemberFormOpen] = useState(false);
  const [memberForm, setMemberForm] = useState(emptyMemberForm);
  const [memberFormError, setMemberFormError] = useState(false);
  const [duplicateNicknameError, setDuplicateNicknameError] = useState("");

  const [editingMemberId, setEditingMemberId] = useState(null);
  const [editMemberForm, setEditMemberForm] = useState(emptyMemberForm);
  const [editMemberFormError, setEditMemberFormError] = useState(false);
  const [editDuplicateNicknameError, setEditDuplicateNicknameError] = useState("");
  const [editDeleteError, setEditDeleteError] = useState("");

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(members));
  }, [members]);

  const activeGroup = useMemo(() => {
    return groups.find((group) => group.id === activeGroupId) || null;
  }, [groups, activeGroupId]);

  useEffect(() => {
    if (groups.length > 0 && !activeGroupId) {
      setActiveGroupId(groups[0].id);
      setScreen("main");
    }

    if (groups.length === 0 && screen === "main") {
      setScreen("home");
    }
  }, [groups, activeGroupId, screen]);

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
  const playCounts = activeGroup?.playCounts || {};
  const selectedSwap = activeGroup?.selectedSwap || null;
  const isRateVisible = activeGroup?.rateDisplay === "あり";

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

  const selectedLayout = useMemo(() => {
    if (!activeGroup) return null;
    const layouts = layoutOptions[Number(activeGroup.courtCount)] || [];
    return layouts.find((layout) => layout.id === activeGroup.layoutId) || null;
  }, [activeGroup]);

  const shouldRotateMainLayout = useMemo(() => {
    return hasThreeOrMoreHorizontalCourts(selectedLayout);
  }, [selectedLayout]);

  const displayLayout = useMemo(() => {
    if (shouldRotateMainLayout) {
      return rotateLayout(selectedLayout);
    }

    return selectedLayout;
  }, [selectedLayout, shouldRotateMainLayout]);

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

  const resetCreateForm = () => {
    setCreateGroupName("");
    setCreateCourtCount("");
    setCreateLayoutId("");
    setCreateRateDisplay("");
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

  const createGroup = () => {
    if (!createGroupName || !createCourtCount || !createLayoutId || !createRateDisplay) {
      setGroupError(true);
      return;
    }

    const newGroup = createGroupObject({
      groupName: createGroupName,
      courtCount: createCourtCount,
      layoutId: createLayoutId,
      rateDisplay: createRateDisplay,
    });

    setGroups((prevGroups) => [...prevGroups, newGroup]);
    setActiveGroupId(newGroup.id);
    resetCreateForm();
    setScreen("main");
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
  };

  const deleteActiveGroup = () => {
    if (!activeGroup) return;

    const confirmDelete = window.confirm(
      `${activeGroup.groupName}のグループを削除しますか？`
    );

    if (!confirmDelete) return;

    const nextGroups = groups.filter((group) => group.id !== activeGroup.id);
    setGroups(nextGroups);

    if (nextGroups.length > 0) {
      setActiveGroupId(nextGroups[0].id);
      setScreen("main");
    } else {
      setActiveGroupId(null);
      setScreen("home");
    }
  };

  const openParticipationModal = () => {
    setTempSelectedIds(Array.from(selectedIds));
    setMemberSearch("");
    setIsNewMemberFormOpen(false);
    setMemberForm(emptyMemberForm);
    setMemberFormError(false);
    setDuplicateNicknameError("");
    setEditingMemberId(null);
    setEditMemberForm(emptyMemberForm);
    setEditMemberFormError(false);
    setEditDuplicateNicknameError("");
    setEditDeleteError("");
    setIsParticipationModalOpen(true);
  };

  const closeParticipationModal = () => {
    setIsParticipationModalOpen(false);
    setTempSelectedIds([]);
    setMemberSearch("");
    setIsNewMemberFormOpen(false);
    setMemberForm(emptyMemberForm);
    setMemberFormError(false);
    setDuplicateNicknameError("");
    setEditingMemberId(null);
    setEditMemberForm(emptyMemberForm);
    setEditMemberFormError(false);
    setEditDuplicateNicknameError("");
    setEditDeleteError("");
  };

  const toggleTempMember = (member) => {
    if (onCourtIds.has(member.id)) return;
    if (editingMemberId) return;

    if (tempSelectedIds.includes(member.id)) {
      setTempSelectedIds(tempSelectedIds.filter((id) => id !== member.id));
    } else {
      setTempSelectedIds([...tempSelectedIds, member.id]);
    }
  };

  const decideParticipation = () => {
    const courtMemberIds = new Set(onCourtIds);

    const selectedWaitingMembers = sortedMembers.filter(
      (member) =>
        tempSelectedIds.includes(member.id) && !courtMemberIds.has(member.id)
    );

    updateActiveGroup((group) => {
      const nextPlayCounts = { ...(group.playCounts || {}) };
      const initialPlayCount = getInitialPlayCountForGroup(group);

      selectedWaitingMembers.forEach((member) => {
        if (typeof nextPlayCounts[member.id] !== "number") {
          nextPlayCounts[member.id] = initialPlayCount;
        }
      });

      return {
        waitingMembers: selectedWaitingMembers,
        playCounts: nextPlayCounts,
        selectedSwap: null,
      };
    });

    closeParticipationModal();
  };

  const nicknameExists = (nickname, ignoreId = null) => {
    return members.some((member) => {
      if (ignoreId && member.id === ignoreId) return false;
      return (member.nickname || member.name) === nickname.trim();
    });
  };

  const saveMember = () => {
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
      reading: memberForm.reading.trim(),
      gender: memberForm.gender,
      rank: memberForm.rank,
      rate: getInitialRate(memberForm.rank),
    };

    setMembers([...members, newMember]);
    setTempSelectedIds([...tempSelectedIds, newMember.id]);
    setMemberForm(emptyMemberForm);
    setMemberFormError(false);
    setDuplicateNicknameError("");
    setIsNewMemberFormOpen(false);
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

  const saveEditedMember = () => {
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

    const editedData = {
      nickname: editMemberForm.nickname.trim(),
      name: editMemberForm.nickname.trim(),
      reading: editMemberForm.reading.trim(),
      gender: editMemberForm.gender,
    };

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
  };

  const deleteEditingMember = () => {
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

    setMembers(members.filter((member) => member.id !== editingMemberId));

    setGroups((prevGroups) =>
      prevGroups.map((group) => ({
        ...group,
        waitingMembers: group.waitingMembers.filter(
          (member) => member.id !== editingMemberId
        ),
      }))
    );

    setTempSelectedIds(tempSelectedIds.filter((id) => id !== editingMemberId));
    closeEditMember();
  };

  const handleSwapTap = (member, location) => {
    if (!member) return;

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

    updateActiveGroup({
      waitingMembers: nextWaitingMembers,
      courts: nextCourts,
      selectedSwap: null,
    });
  };

  const isSwapSelected = (member) => {
    return selectedSwap?.member?.id === member.id;
  };

  const generateCourt = (index) => {
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
      playCounts
    );

    if (!game) return;

    const usedIds = new Set([...game.teamA, ...game.teamB].map((m) => m.id));

    const newCourts = [...courts];
    newCourts[index] = { ...game, winner: null };

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

    const nextPlayCounts = { ...playCounts };
    [...game.teamA, ...game.teamB].forEach((m) => {
      nextPlayCounts[m.id] = (nextPlayCounts[m.id] || 0) + 1;
    });

    updateActiveGroup({
      courts: newCourts,
      waitingMembers: availableMembers.filter((m) => !usedIds.has(m.id)),
      pairHistory: nextPairHistory,
      opponentHistory: nextOpponentHistory,
      relationshipHistory: nextRelationshipHistory,
      playCounts: nextPlayCounts,
      selectedSwap: null,
    });
  };

  const clearCourt = (index) => {
    if (!courts[index]) return;

    const courtMembers = [...courts[index].teamA, ...courts[index].teamB];
    const newCourts = [...courts];
    newCourts[index] = null;

    updateActiveGroup({
      courts: newCourts,
      waitingMembers: [...waitingMembers, ...courtMembers],
      selectedSwap: null,
    });
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

  const confirmCourtResult = (index) => {
    const targetCourt = courts[index];
    if (!targetCourt || !targetCourt.winner) return;

    const winnerTeam =
      targetCourt.winner === "A" ? targetCourt.teamA : targetCourt.teamB;
    const loserTeam =
      targetCourt.winner === "A" ? targetCourt.teamB : targetCourt.teamA;

    const rateMove = calculateRateMove(winnerTeam, loserTeam);
    const winnerIds = new Set(winnerTeam.map((member) => member.id));
    const loserIds = new Set(loserTeam.map((member) => member.id));

    const updateRate = (member) => {
      if (winnerIds.has(member.id)) {
        return applyRateToMember(member, rateMove);
      }

      if (loserIds.has(member.id)) {
        return applyRateToMember(member, -rateMove);
      }

      return member;
    };

    setMembers((prevMembers) => prevMembers.map(updateRate));

    setGroups((prevGroups) =>
      prevGroups.map((group) => {
        const updatedWaitingMembers = group.waitingMembers.map(updateRate);

        const updatedCourts = group.courts.map((court, courtIndex) => {
          if (!court) return court;

          if (group.id === activeGroupId && courtIndex === index) {
            return null;
          }

          return {
            ...court,
            teamA: court.teamA.map(updateRate),
            teamB: court.teamB.map(updateRate),
          };
        });

        if (group.id !== activeGroupId) {
          return {
            ...group,
            waitingMembers: updatedWaitingMembers,
            courts: updatedCourts,
          };
        }

        const updatedCourtMembers = [
          ...targetCourt.teamA,
          ...targetCourt.teamB,
        ].map(updateRate);

        return {
          ...group,
          waitingMembers: [...updatedWaitingMembers, ...updatedCourtMembers],
          courts: updatedCourts,
          selectedSwap: null,
        };
      })
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
          isSwapSelected(member)
            ? `playerChip selectedPlayerChip ${genderClass}`
            : `playerChip ${genderClass}`
        }
        onClick={() => handleSwapTap(member, location)}
      >
        <span>{member.nickname || member.name}</span>
        {isRateVisible && (
          <span className="playerRate">R{getMemberRate(member)}</span>
        )}
      </button>
    );
  };

  const renderCourt = (courtNumber) => {
    const index = courtNumber - 1;
    const court = courts[index];

    return (
      <div
        key={index}
        className={
          shouldRotateMainLayout
            ? "courtVisual courtVisualRotated"
            : "courtVisual"
        }
      >
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
              <button className="winButton" onClick={() => setWinner(index, "A")}>
                勝ち
              </button>
            </div>

            <div className="vs">VS</div>

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
              <button className="winButton" onClick={() => setWinner(index, "B")}>
                勝ち
              </button>
            </div>
          </div>
        ) : (
          <div className="emptyCourt">空き</div>
        )}

        <div className="row">
          <button
            onClick={() =>
              court?.winner ? confirmCourtResult(index) : generateCourt(index)
            }
          >
            {court?.winner ? "確定" : "新規"}
          </button>
          <button className="subButton" onClick={() => clearCourt(index)}>
            消す
          </button>
        </div>
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
            onChange={(e) => setForm({ ...form, nickname: e.target.value })}
            placeholder="例：たなか"
          />
        </label>
        {formError && !form.nickname.trim() && (
          <p className="errorText">入力してください</p>
        )}

        <label>
          読み方
          <input
            value={form.reading}
            onChange={(e) => setForm({ ...form, reading: e.target.value })}
            placeholder="例：たなか"
          />
          <span className="inputNoteRed">必ずひらがなで入力してください</span>
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

        <div className="bottomActions">
          <button onClick={onSave}>{isEdit ? "決定" : "登録"}</button>
          <button className="subButton" onClick={onClose}>
            {isEdit ? "もどる" : "閉じる"}
          </button>
        </div>

        {!isEdit && duplicateError && (
          <p className="errorText centerText">{duplicateError}</p>
        )}

        {isEdit && duplicateError && (
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

          <button className="addGroupTab" onClick={startCreateGroup}>
            ＋
          </button>
        </div>
      </div>
    );
  };

  if (screen === "home") {
    return (
      <div className="app homeScreen">
        <h1>バドミントン組み合わせアプリ</h1>
        <button className="bigCreateButton" onClick={startCreateGroup}>
          新規作成
        </button>
      </div>
    );
  }

  if (screen === "create") {
    return (
      <div className="app">
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
          <h2>レート表示</h2>
          <div className="optionGrid">
            {rateDisplayOptions.map((option) => (
              <button
                key={option}
                onClick={() => setCreateRateDisplay(option)}
                className={
                  createRateDisplay === option ? "option selectedOption" : "option"
                }
              >
                {option}
              </button>
            ))}
          </div>
          {groupError && !createRateDisplay && (
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
        <h1>バドミントン組み合わせアプリ</h1>
        <button className="bigCreateButton" onClick={startCreateGroup}>
          新規作成
        </button>
      </div>
    );
  }

  return (
    <div className="app">
      {renderTabs()}

      <div className="mainTitleRow">
        <h1>{activeGroup.groupName}</h1>
        <button className="deleteGroupButton" onClick={deleteActiveGroup}>
          グループ削除
        </button>
      </div>

      <section className="card">
        <div className="sectionHeader">
          <h2>メンバー</h2>
          <button onClick={openParticipationModal}>参加</button>
        </div>
        <p className="participantCount">参加中：{selectedIds.size}人</p>
        <p className="rateDisplayStatus">
          レート表示：{isRateVisible ? "あり" : "なし"}
        </p>
      </section>

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
        <h2>休憩</h2>
        <div className="waitingList">
          {waitingMembers.map((member, index) => (
            <button
              key={member.id}
              className={
                isSwapSelected(member)
                  ? "waitingChip selectedPlayerChip"
                  : "waitingChip"
              }
              onClick={() =>
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
            </button>
          ))}
        </div>
      </section>

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

            <div className="participationActions">
              <button onClick={() => setIsNewMemberFormOpen(!isNewMemberFormOpen)}>
                新規登録
              </button>
              <span className="longPressHint">長押しで編集</span>
            </div>

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

            <div className="memberGrid modalMemberGrid">
              {filteredMembers.map((member) => {
                const isSelected = tempSelectedIds.includes(member.id);
                const isOnCourt = onCourtIds.has(member.id);

                return (
                  <button
                    key={member.id}
                    onClick={() => toggleTempMember(member)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openEditMember(member);
                    }}
                    onTouchStart={(e) => {
                      e.currentTarget.longPressTimer = setTimeout(() => {
                        openEditMember(member);
                      }, 650);
                    }}
                    onTouchEnd={(e) => {
                      clearTimeout(e.currentTarget.longPressTimer);
                    }}
                    onMouseDown={(e) => {
                      e.currentTarget.longPressTimer = setTimeout(() => {
                        openEditMember(member);
                      }, 650);
                    }}
                    onMouseUp={(e) => {
                      clearTimeout(e.currentTarget.longPressTimer);
                    }}
                    onMouseLeave={(e) => {
                      clearTimeout(e.currentTarget.longPressTimer);
                    }}
                    className={
                      isSelected
                        ? "member selected modalMember"
                        : "member modalMember"
                    }
                  >
                    <strong>{member.nickname || member.name}</strong>
                    <span>{member.reading}</span>
                    {isRateVisible && (
                      <span className="memberRate">R{getMemberRate(member)}</span>
                    )}
                    {isOnCourt && <small>試合中</small>}
                  </button>
                );
              })}
            </div>

            <div className="bottomActions">
              <button onClick={decideParticipation}>決定</button>
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