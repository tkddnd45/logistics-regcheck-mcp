import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/* ------------------------------------------------------------------ */
/*  환경변수 (Render 등 호스팅의 Environment 설정에서 넣어줍니다)       */
/* ------------------------------------------------------------------ */
const VWORLD_KEY = process.env.VWORLD_KEY;
const VWORLD_DOMAIN = process.env.VWORLD_DOMAIN || ""; // 브이월드 콘솔에 등록한 주소와 맞춰야 함 (서버는 도메인 제한이 보통 느슨하지만, 비워두면 값 없이 요청됨)
const LAW_OC = process.env.LAW_OC;
const PORT = process.env.PORT || 3000;

if (!VWORLD_KEY) console.warn("[경고] VWORLD_KEY 환경변수가 설정되지 않았습니다.");
if (!LAW_OC) console.warn("[경고] LAW_OC 환경변수가 설정되지 않았습니다.");

/* ------------------------------------------------------------------ */
/*  용도지역 명칭 목록 (브이월드 응답 속성값에서 실제 용도지역명을      */
/*  찾아내는 데 사용)                                                  */
/* ------------------------------------------------------------------ */
const ZONE_LAYERS = [
  { id: "LT_C_UQ111", label: "도시지역" },
  { id: "LT_C_UQ112", label: "관리지역" },
  { id: "LT_C_UQ113", label: "농림지역" },
  { id: "LT_C_UQ114", label: "자연환경보전지역" },
];
const ZONE_NAMES = [
  "계획관리지역", "생산관리지역", "보전관리지역", "자연녹지지역", "생산녹지지역", "보전녹지지역",
  "전용공업지역", "일반공업지역", "준공업지역", "농림지역", "자연환경보전지역",
  "제1종전용주거지역", "제2종전용주거지역", "제1종일반주거지역", "제2종일반주거지역", "제3종일반주거지역",
  "준주거지역", "중심상업지역", "일반상업지역", "근린상업지역", "유통상업지역",
];
function matchZoneName(text) { return text ? (ZONE_NAMES.find((n) => text.includes(n)) || null) : null; }

// 용도지역별 건폐율·용적률 상한 (국토의 계획 및 이용에 관한 법률 시행령 제84조·제85조, 2026.7.1 시행 기준)
const ZONE_LAW_LIMITS = {
  "계획관리지역": { bcr: 40, farMin: 50, farMax: 100 },
  "생산관리지역": { bcr: 20, farMin: 50, farMax: 80 },
  "보전관리지역": { bcr: 20, farMin: 50, farMax: 80 },
  "자연녹지지역": { bcr: 20, farMin: 50, farMax: 100 },
  "전용공업지역": { bcr: 70, farMin: 150, farMax: 300 },
  "일반공업지역": { bcr: 70, farMin: null, farMax: 350 },
  "준공업지역": { bcr: 70, farMin: null, farMax: 400 },
};

function pickProp(p, candidates) {
  if (!p) return null;
  for (const c of candidates) { if (p[c] !== undefined && p[c] !== null && p[c] !== "") return p[c]; }
  return null;
}
function firstFeature(resp) {
  return resp?.response?.result?.featureCollection?.features?.[0] || null;
}

/* ------------------------------------------------------------------ */
/*  브이월드 API 호출 (서버 간 통신이라 CORS·JSONP 우회가 필요 없음)    */
/* ------------------------------------------------------------------ */
async function vworldGeocode(address) {
  const url = "https://api.vworld.kr/req/address?service=address&request=getcoord&version=2.0&crs=epsg:4326"
    + "&address=" + encodeURIComponent(address)
    + "&refine=true&simple=false&format=json&type=parcel"
    + "&key=" + VWORLD_KEY + (VWORLD_DOMAIN ? "&domain=" + encodeURIComponent(VWORLD_DOMAIN) : "");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`브이월드 geocode HTTP ${res.status}`);
  return res.json();
}
async function vworldData(layerId, extraParams) {
  let url = "https://api.vworld.kr/req/data?service=data&version=2.0&request=GetFeature&format=json&crs=epsg:4326"
    + "&size=5&page=1&data=" + layerId + "&geometry=false&attribute=true"
    + "&key=" + VWORLD_KEY + (VWORLD_DOMAIN ? "&domain=" + encodeURIComponent(VWORLD_DOMAIN) : "");
  if (extraParams) url += extraParams;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`브이월드 data HTTP ${res.status}`);
  return res.json();
}
async function vworldLandPrice(pnu) {
  const url = "https://api.vworld.kr/ned/data/getIndvdLandPriceAttr?pnu=" + encodeURIComponent(pnu)
    + "&format=json&numOfRows=50&pageNo=1&key=" + VWORLD_KEY + (VWORLD_DOMAIN ? "&domain=" + encodeURIComponent(VWORLD_DOMAIN) : "");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`브이월드 공시지가 HTTP ${res.status}`);
  return res.json();
}

async function lookupParcelViaVWorld(address) {
  const geo = await vworldGeocode(address);
  const point = geo?.response?.result?.point;
  if (!point) return { success: false, reason: "주소를 좌표로 변환하지 못했습니다 (지오코딩 실패). 지번 주소 표기를 확인해주세요." };
  const { x, y } = point;
  const structure = geo.response.refined?.structure;
  const cityName = structure ? (structure.level2 || structure.level1 || null) : null;

  const cadastral = await vworldData("LP_PA_CBND_BUBUN", "&geomFilter=" + encodeURIComponent(`POINT(${x} ${y})`));
  const cprops = firstFeature(cadastral)?.properties || {};
  const pnu = cprops.pnu || cprops.PNU || null;
  if (!pnu) return { success: false, reason: "좌표는 찾았지만 필지 정보를 확인하지 못했습니다.", cityName };

  let jimok = null, areaVal = null;
  try {
    const landInfo = await vworldData("LT_C_LANDINFOBASEMAP", "&geomFilter=" + encodeURIComponent(`POINT(${x} ${y})`));
    const lprops = firstFeature(landInfo)?.properties || null;
    jimok = pickProp(lprops, ["jimok_nm", "JIMOK_NM", "jimok", "lndcgr_nm", "jimokNm"]);
    areaVal = pickProp(lprops, ["parea", "PAREA", "area", "AREA", "lndpcl_ar"]);
  } catch (e) { /* 지목·면적은 참고용이라 실패해도 나머지는 계속 진행 */ }

  let zoneName = null;
  for (const layer of ZONE_LAYERS) {
    const r = await vworldData(layer.id, "&geomFilter=" + encodeURIComponent(`POINT(${x} ${y})`));
    const f = firstFeature(r);
    if (f) {
      const props = f.properties || {};
      zoneName = (props.uname && matchZoneName(props.uname)) ? props.uname : matchZoneName(JSON.stringify(props));
      break;
    }
  }

  const zoneLimits = zoneName ? ZONE_LAW_LIMITS[zoneName] || null : null;
  return {
    success: true, pnu, cityName, zoneName, jimok, area: areaVal,
    zoneLawLimits: zoneLimits,
    zoneLawSource: "국토의 계획 및 이용에 관한 법률 시행령 제84조·제85조 (2026.7.1 시행 기준, 시·군 조례로 별도 확정될 수 있음)",
  };
}

/* ------------------------------------------------------------------ */
/*  법제처 자치법규 API                                                */
/* ------------------------------------------------------------------ */
async function lawSearchOrdin(query) {
  const url = "https://www.law.go.kr/DRF/lawSearch.do?OC=" + encodeURIComponent(LAW_OC)
    + "&target=ordin&type=JSON&display=20&query=" + encodeURIComponent(query);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`법제처 검색 HTTP ${res.status}`);
  return res.json();
}
async function lawServiceOrdin(mst) {
  const url = "https://www.law.go.kr/DRF/lawService.do?OC=" + encodeURIComponent(LAW_OC)
    + "&target=ordin&type=JSON&MST=" + encodeURIComponent(mst);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`법제처 본문조회 HTTP ${res.status}`);
  return res.json();
}
// 응답 JSON 구조가 불확실한 데다 검색결과가 1건이면 배열이 아니라 단일
// 객체로 오는 경우가 있어, 재귀적으로 훑어서 해당 필드를 가진 객체를 직접 찾는다.
function deepFindByField(obj, fieldIncludes, matchFn, out) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) { obj.forEach((it) => deepFindByField(it, fieldIncludes, matchFn, out)); return; }
  const entry = Object.entries(obj).find(([k]) => fieldIncludes.some((f) => k.includes(f)));
  if (entry && matchFn(entry[1])) out.push(obj);
  Object.values(obj).forEach((v) => deepFindByField(v, fieldIncludes, matchFn, out));
}
function findOrdinCandidates(searchJson, keyword) {
  const out = [];
  deepFindByField(searchJson, ["자치법규명"], (v) => typeof v === "string" && v.includes(keyword), out);
  return out;
}
function findJoArray(serviceJson) {
  const out = [];
  deepFindByField(serviceJson, ["조내용", "조문내용"], () => true, out);
  return out;
}
function joText(item) { const e = Object.entries(item).find(([k]) => k.includes("조내용") || k.includes("조문내용")); return e ? String(e[1]) : ""; }
function joTitle(item) { const e = Object.entries(item).find(([k]) => k.includes("조제목")); return e ? String(e[1]) : ""; }
function mstOf(item) { const e = Object.entries(item).find(([k]) => k.includes("자치법규일련번호") || k === "MST"); return e ? String(e[1]) : null; }
function nameOf(item) { const e = Object.entries(item).find(([k]) => k.includes("자치법규명")); return e ? String(e[1]) : ""; }

async function searchOrdinance(cityName, keywords) {
  const query = `${cityName} 도시계획 조례`;
  const searchJson = await lawSearchOrdin(query);
  const candidates = findOrdinCandidates(searchJson, "도시계획 조례");
  if (candidates.length === 0) {
    return { success: false, reason: `"${query}" 검색 결과에서 도시계획 조례를 찾지 못했습니다.` };
  }
  const mst = mstOf(candidates[0]);
  const ordinanceName = nameOf(candidates[0]);
  if (!mst) return { success: false, reason: "자치법규 일련번호(MST)를 확인하지 못했습니다." };

  const bodyJson = await lawServiceOrdin(mst);
  const joArray = findJoArray(bodyJson);
  const kw = keywords && keywords.length ? keywords : ["창고", "건폐율", "용적률", "주차"];
  const articles = joArray
    .filter((it) => kw.some((k) => (joTitle(it) + " " + joText(it)).includes(k)))
    .map((it) => ({ title: joTitle(it), text: joText(it) }));

  return { success: true, ordinanceName, mst, articles };
}

/* ------------------------------------------------------------------ */
/*  MCP 서버 정의 — 위 함수들을 Claude가 쓸 수 있는 "도구"로 노출        */
/* ------------------------------------------------------------------ */
function buildServer() {
  const server = new McpServer({ name: "logistics-regcheck", version: "1.0.0" });

  server.registerTool(
    "lookup_parcel",
    {
      title: "지번으로 필지 정보 조회",
      description: "지번 주소를 입력하면 브이월드(V-World) API로 용도지역, 지목, 지적면적, PNU, 소재 시·군, 그리고 해당 용도지역의 건폐율·용적률 시행령 상한을 조회합니다. 물류창고 법규검토의 첫 단계로 사용하세요.",
      inputSchema: { lotAddress: z.string().describe("지번 주소 (예: 경기도 여주시 연라동 552-7)") },
    },
    async ({ lotAddress }) => {
      try {
        const result = await lookupParcelViaVWorld(lotAddress);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: String(e.message || e) }) }], isError: true };
      }
    }
  );

  server.registerTool(
    "lookup_land_price",
    {
      title: "개별공시지가 조회",
      description: "lookup_parcel로 얻은 PNU를 입력하면 브이월드 API로 가장 최근 연도의 개별공시지가(원/㎡)를 조회합니다.",
      inputSchema: { pnu: z.string().describe("19자리 필지고유번호(PNU), lookup_parcel 결과에서 얻습니다.") },
    },
    async ({ pnu }) => {
      try {
        const r = await vworldLandPrice(pnu);
        const list = r?.indvdLandPrices?.field || [];
        let latest = null;
        list.forEach((item) => {
          const y = parseInt(item.stdrYear || item.stdrYr, 10);
          if (!latest || y > parseInt(latest.stdrYear || latest.stdrYr, 10)) latest = item;
        });
        const price = latest ? (latest.pblntfPclnd || latest.pubLandPrice) : null;
        const year = latest ? (latest.stdrYear || latest.stdrYr) : null;
        return { content: [{ type: "text", text: JSON.stringify({ success: !!price, price, year }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: String(e.message || e) }) }], isError: true };
      }
    }
  );

  server.registerTool(
    "search_ordinance",
    {
      title: "지자체 도시계획 조례 검색",
      description: "시·군 이름을 입력하면 법제처 자치법규 API로 그 지역의 '도시계획 조례'를 찾아, 지정한 키워드(기본: 창고, 건폐율, 용적률, 주차)가 포함된 조문 원문을 전부 가져옵니다. 창고시설 행위가능여부·건폐율·용적률 등 조례 확인이 필요한 항목에 사용하세요. 반환된 조문은 원문 그대로이니 직접 읽고 판단해서 답변하세요.",
      inputSchema: {
        cityName: z.string().describe("시·군 이름 (예: 안성시, 여주시)"),
        keywords: z.array(z.string()).optional().describe("검색할 키워드 목록. 생략하면 기본값(창고, 건폐율, 용적률, 주차) 사용"),
      },
    },
    async ({ cityName, keywords }) => {
      try {
        const result = await searchOrdinance(cityName, keywords);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: String(e.message || e) }) }], isError: true };
      }
    }
  );

  return server;
}

/* ------------------------------------------------------------------ */
/*  HTTP 서버 (Claude Desktop 등에서 원격 커넥터로 연결하는 진입점)      */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/", (req, res) => {
  res.send("물류창고 법규검토 MCP 서버가 실행 중입니다. Claude Desktop에서 /mcp 경로로 연결하세요.");
});

app.listen(PORT, () => {
  console.log(`MCP 서버가 포트 ${PORT}에서 실행 중입니다.`);
});
