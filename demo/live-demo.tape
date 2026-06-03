# Live-model demo: a real model (Gemini 2.5 Flash) autonomously fixes a real bug to green.
# Secrets are inherited from the environment, never written here. Run:
#   OPENAI_API_KEY=... MAESTRO_OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai \
#   MAESTRO_OPENAI_MODEL=gemini-2.5-flash vhs demo/live-demo.tape

Output demo/live-demo.mp4

Set Shell "bash"
Set FontSize 15
Set Width 1500
Set Height 1000
Set Theme "Catppuccin Mocha"
Set Padding 30
Set Margin 20
Set BorderRadius 12
Set TypingSpeed 22ms

Hide
Type "cd ~/Documents/projects/personal/maestro"
Enter
Type "clear"
Enter
Show
Sleep 400ms
Type "FIXTURE=one-bug TOOLSET=full RATE=2 npx tsx demo/live-run.ts"
Enter
Sleep 125s
