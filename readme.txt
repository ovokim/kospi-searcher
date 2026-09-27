📋 순서대로 따라하세요
1단계: Node.js 설치 확인

PowerShell 또는 CMD 열어서:

node --version

출력이 안 나오면 https://nodejs.org/ 에서 LTS 버전 설치

2단계: 폴더 정리

예: C:\Users\0voki\work\kospi-server 폴더 생성

그 안에 다운로드한 파일 3개 저장:

C:\Users\0voki\work\kospi-server\
├── krx_server.js
├── package.json
└── stock_management_system_krx.html
3단계: 터미널 열기

폴더에서 마우스 우클릭 → "PowerShell 여기서 열기"

또는:

cd C:\Users\0voki\work\kospi-server
4단계: 설치 및 실행

터미널에 입력:

bash
npm install

완료 후:

bash
npm start

출력 (예시):

╔════════════════════════════════════════╗
║   KRX 종목 검색 서버                   ║
╠════════════════════════════════════════╣
║ 🚀 포트: http://localhost:3000         ║
║ 📊 캐시 종목: 1500개                    ║
║ 🔑 API키: D3AF2718...                   ║
╚════════════════════════════════════════╝
5단계: HTML 열기

새로운 PowerShell/CMD 열어서:

bash
start stock_management_system_krx.html

또는 파일 탐색기에서 더블클릭

⚠️ 주의사항
✅ 터미널은 계속 실행 상태 유지 (닫으면 안 됨)
✅ HTML은 별도 창에서 열기
✅ 처음 검색은 10~30초 걸림 (KRX API 호출 중)
🆘 만약 오류가 나면?

"npm: 명령을 찾을 수 없음" → Node.js 재설치
"포트 3000이 이미 사용 중" → 다른 프로그램 종료 후 다시 시도
"HTML 열어도 안 보임" → 서버가 실행 중인지 확인

어디서 막히셨어요? 😊a