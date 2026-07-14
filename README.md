vencord/equicord plugin to autocompress media files to fit discord upload limit. works using ffmpeg on path.

# how to use

install vencord directly from https://github.com/Vendicated/Vencord (pre built installations don't allow userplugins)
install ffmpeg and add it to PATH
mkdir Vencord/src/userplugins/
copy this folder to Vencord/src/userplugins/theCollective

```bash
git clone https://github.com/Vendicated/Vencord
mkdir -p Vencord/src/userplugins/
git clone https://github.com/aaryanparveen/theCollective ./Vencord/src/userplugins/theCollective

cd Vencord
pnpm install
pnpm build
pnpm inject
```
