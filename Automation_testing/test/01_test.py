from playwright.sync_api import expect


def test_login(page):
        page.goto("https://eagrology-revamp.indevconsultancy.in/login")
        page.get_by_placeholder("Email, username or phone number").fill("admin@e-agrology.local")
        page.get_by_placeholder("Enter your password").fill("Admin@321")
        page.get_by_role("button", name="Log in").click()
        
        page.wait_for_timeout(3000)
        print("Succesfully  Logged in")