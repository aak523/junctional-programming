import subprocess, sys
sys.exit(subprocess.call([sys.executable, r'C:\Users\adamk\junctional-programming\experiments\gpu-world\service.py', r'C:\Users\adamk\junctional-programming\experiments\gpu-world\state\seed2_1.json', ' '.join(sys.argv[1:])]))
