export const MY_ID = "demo-me";
export const MY_SCORE = 3500;
export interface Profile {
  id: string;
  matchId: string;
  name: string;
  major: string;
  year: string;
  score: number;
  bio: string;
  intro: string;
  interests: string[];
  tone: "rose" | "sage" | "sand";
}
/** 화면 검토용 가상 인물이다. 실제 학생 데이터가 아니다. */
export const profiles: Profile[] = [
  {
    id: "demo-seoyeon",
    matchId: "match-seoyeon",
    name: "서연",
    major: "컴퓨터학과",
    year: "23학번",
    score: -3490,
    tone: "rose",
    bio: "좋은 노래를 찾으면 나누고 싶어지는 사람.",
    intro:
      "수업이 끝나면 플레이리스트를 틀고 캠퍼스를 걸어요. 가끔은 목적지 없는 산책이 제일 좋더라고요. 함께 좋아하는 것들을 나눌 수 있으면 좋겠어요.",
    interests: ["인디 음악", "밤 산책", "필름 사진"],
  },
  {
    id: "demo-jiwoo",
    matchId: "match-jiwoo",
    name: "지우",
    major: "수학과",
    year: "24학번",
    score: -3530,
    tone: "sage",
    bio: "커피 한 잔과 오래 이어지는 대화를 좋아해요.",
    intro:
      "조용한 카페에서 책 읽는 시간을 좋아해요. 수학 문제보다 서로 다른 사람의 생각을 알아가는 일이 더 흥미로울 때도 있어요.",
    interests: ["독립 서점", "드립 커피", "영화"],
  },
  {
    id: "demo-minjun",
    matchId: "match-minjun",
    name: "민준",
    major: "기계공학부",
    year: "22학번",
    score: -3600,
    tone: "sand",
    bio: "작은 발견을 함께 즐길 수 있는 인연이면 좋겠어요.",
    intro:
      "한 주에 한 번은 새로운 곳을 가보려고 해요. 사진으로 기록하고, 다음에 가볼 곳을 찾는 게 취미예요. 서로의 일상에 좋은 자극이 되고 싶어요.",
    interests: ["전시", "러닝", "동네 탐방"],
  },
];
export const signed = (value: number) =>
  `${value >= 0 ? "+" : "−"}${Math.abs(value).toLocaleString("ko-KR")}`;
