import os
import sys
import subprocess
import requests
from dotenv import load_dotenv

def run_command(cmd, input_data=None):
    """실행 중인 서브프로세스 헬퍼"""
    try:
        proc = subprocess.Popen(
            cmd,
            shell=True,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        stdout, stderr = proc.communicate(input=input_data)
        return proc.returncode, stdout.strip(), stderr.strip()
    except Exception as e:
        return -1, "", str(e)

def main():
    # 1. 로컬 .env 파일 로드
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(env_path):
        print("❌ 에러: 로컬 프로젝트 루트에 .env 파일이 존재하지 않습니다.")
        sys.exit(1)
        
    load_dotenv(dotenv_path=env_path)
    client_id = os.getenv("TOSS_CLIENT_ID")
    client_secret = os.getenv("TOSS_CLIENT_SECRET")
    
    if not client_id or not client_secret:
        print("❌ 에러: .env 파일에 TOSS_CLIENT_ID 혹은 TOSS_CLIENT_SECRET이 누락되었습니다.")
        sys.exit(1)

    print("🔑 [1단계] 로컬 화이트리스트 IP 기반으로 토스 OpenAPI 토큰 발급 요청 중...")
    
    # 2. 토스 Oauth 토큰 발급 API 호출
    base_url = "https://openapi.tossinvest.com"
    token_endpoint = "/oauth2/token"
    try:
        r = requests.post(
            f"{base_url}{token_endpoint}",
            data={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret
            },
            timeout=5.0
        )
        if r.status_code != 200:
            print(f"❌ 에러: 토스 토큰 발급 API 실패 (코드 {r.status_code})")
            print(f"상세 원인: {r.text}")
            sys.exit(1)
            
        token_data = r.json()
        access_token = token_data.get("access_token")
        token_type = token_data.get("token_type", "Bearer")
        
        if not access_token:
            print("❌ 에러: 응답받은 토큰 데이터에 access_token이 누락되어 있습니다.")
            sys.exit(1)
            
        print("✅ 토큰 발급 성공!")
        print(f"   • Token Type: {token_type}")
        print(f"   • Access Token: {access_token[:15]}... (보안 생략)")
        
    except Exception as e:
        print(f"❌ 에러: 토스 API 통신 중 예외 발생: {e}")
        sys.exit(1)

    # 3. Vercel CLI 설치/인증 여부 검사
    print("\n🔍 [2단계] Vercel CLI 인증 및 상태 검사 중...")
    code, out, err = run_command("vercel whoami")
    if code != 0:
        print("❌ 에러: 로컬 환경에 Vercel CLI가 설치되어 있지 않거나 로그인 상태가 아닙니다.")
        print("         먼저 'npm install -g vercel' 설치 및 'vercel login'을 실행해 주세요.")
        print(f"상세 에러: {err}")
        sys.exit(1)
    print(f"✅ Vercel 계정 연동 확인 완료: {out}")

    # 4. Vercel 원격 환경 변수 업데이트
    print("\n🌐 [3단계] Vercel 환경 변수 원격 동기화 시작...")
    
    variables = {
        "TOSS_ACCESS_TOKEN": access_token,
        "TOSS_TOKEN_TYPE": token_type
    }
    
    for key, value in variables.items():
        # 기존 환경 변수 삭제 시도 (에러는 무시)
        run_command(f"vercel env rm {key} production -y")
        
        # 새 환경 변수 등록
        code, out, err = run_command(f"vercel env add {key} production", input_data=value)
        if code != 0:
            print(f"❌ 에러: Vercel 환경 변수 {key} 등록 실패!")
            print(f"상세 에러: {err}")
            sys.exit(1)
        print(f"   • 환경 변수 {key} 등록 성공!")

    print("✅ Vercel 원격 환경 변수 동기화가 성공적으로 완료되었습니다.")

    # 5. Git을 통한 배포 유도 혹은 Vercel CLI 배포 실행 선택
    print("\n🚀 [4단계] Vercel 배포 트리거 시작...")
    print("💡 Git push를 통해 원격 배포를 트리거합니다.")
    
    # 변경 사항 추가 및 커밋
    run_command("git add src/config/setup.py adapter/toss_api/toss_client.py")
    code, out, err = run_command('git commit -m "Configure: Support manual TOSS token override via environment variables"')
    
    # GitHub Push
    print("📤 GitHub 원격 저장소에 코드 푸시 중...")
    code, out, err = run_command("git push origin main")
    if code == 0:
        print("✅ 성공: 원격 GitHub 저장소에 코드가 성공적으로 푸시되었습니다!")
        print("🎉 Vercel에서 자동으로 주입된 토스 토큰을 물고 빌드 및 배포를 완료할 것입니다.")
    else:
        print("⚠️ 경고: GitHub 푸시 도중 오류가 발생했습니다. 수동으로 git push를 수행해 주세요.")
        print(f"상세 정보: {err}")

if __name__ == "__main__":
    main()
