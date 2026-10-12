import pytest
from playwright.sync_api import sync_playwright


# BASE_URL="https://eagrology-revamp.indevconsultancy.in/login"
# USERNAME="admin@e-arology.example"
# PASSWORD="Admin@321"

 
@pytest.fixture
def page():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page()
        yield page
        browser.close()


        

# def login(page,username=USERNAME, password=PASSWORD):
#     page.goto(BASE_URL, wait_until="networkidle")
#     page.get_by_placeholder("Email, username or phone number").fill("admin@e-agrology.local")
#     page.get_by_placeholder("Enter your password").fill("Admin@321")
#     page.get_by_role("button", name="Log in").click()
#     page.wait_for_timeout(3000)