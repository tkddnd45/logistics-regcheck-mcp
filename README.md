# 물류창고 법규검토 MCP 서버

지번을 입력하면 브이월드(V-World) API로 용도지역·지목·지적면적·공시지가를,
법제처 API로 관련 지자체 조례 원문을 조회하는 3개의 도구(tool)를 Claude에 제공합니다.
API 키는 이 서버 안에만 저장되고 브라우저에 노출되지 않습니다.

## 도구 목록
- `lookup_parcel` — 지번 주소 → 용도지역, 지목, 지적면적, PNU, 시·군, 건폐율·용적률 시행령 상한
- `lookup_land_price` — PNU → 최근 개별공시지가
- `search_ordinance` — 시·군 이름 → 관련 도시계획 조례 조문 원문

## 1. Render.com에 배포하기

1. 이 폴더(`mcp-server`)를 GitHub 저장소로 만들어 올립니다 (지난번 `logistics-regcheck` 저장소처럼 새 저장소를 만드시면 됩니다).
2. https://render.com 에서 가입 후 **New > Web Service**를 선택합니다.
3. 방금 만든 GitHub 저장소를 연결합니다.
4. 설정값:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. **Environment** 탭에서 아래 3개 환경변수를 추가합니다 (`.env.example` 참고):
   - `VWORLD_KEY` — 발급받으신 브이월드 인증키
   - `VWORLD_DOMAIN` — 배포 후 Render가 알려주는 서버 주소 (예: `https://logistics-regcheck-mcp.onrender.com`). 배포가 끝나야 정확한 주소를 알 수 있으니, 처음엔 비워두고 배포 후 주소가 나오면 다시 채워 넣고 재배포하면 됩니다.
   - `LAW_OC` — 발급받으신 법제처 OC 값
6. **Create Web Service**를 누르면 몇 분 안에 배포가 끝나고, `https://[서비스이름].onrender.com` 형태의 주소가 생깁니다.

> 브이월드 콘솔([오픈API > 인증키 관리])에도 이 서버 주소를 등록해주셔야 도메인 검증을 통과합니다.

## 2. Claude Desktop에서 연결하기 (본인 및 동료분들)

1. Claude Desktop 앱을 엽니다.
2. **설정(Settings) > 커넥터(Connectors) > 커스텀 커넥터 추가**로 들어갑니다.
3. 이름은 자유롭게(예: "물류창고 법규검토"), 주소는 `https://[배포된 주소]/mcp` 를 입력합니다.
   (예: `https://logistics-regcheck-mcp.onrender.com/mcp`)
4. 저장하면 연결됩니다. 이제 Claude Desktop 채팅창에서 "경기도 안성시 죽산면 장능리 산35 지번 법규검토해줘"처럼 요청하면, Claude가 이 서버의 도구로 데이터를 가져와서 직접 읽고 검토서를 작성합니다.

동료분들도 같은 방식으로 이 서버 주소만 알면 각자 본인 Claude Desktop에 연결해서 쓸 수 있습니다 — 별도 계정이나 비용 없이, 각자의 Claude 사용량 안에서 동작합니다.

## 참고 — 무료 티어 유의사항

Render 무료 티어는 일정 시간 요청이 없으면 서버가 잠들었다가, 다음 요청 시 다시 깨어나는 데 몇십 초 걸릴 수 있습니다. 처음 요청이 느리게 느껴지면 이 때문일 수 있습니다.
