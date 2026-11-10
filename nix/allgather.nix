{
  lib,
  stdenv,
  bun,
  bun2nix,
  makeWrapper,
  git,
  openssh,
}: let
  manifest = builtins.fromJSON (builtins.readFile ../package.json);
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [../LICENSE ../package.json ../tsconfig.json ../bun.lock ../bun.nix ../toolchain/package.json ../scripts ../server ../cli ../shared ../web];
  };
  bunDeps = assert lib.assertMsg (bun2nix.version == manifest.devDependencies.bun2nix)
  "The bun2nix generator must match the flake input.";
    bun2nix.fetchBunDeps {bunNix = ../bun.nix;};
in
  stdenv.mkDerivation {
    pname = "allgather";
    version = manifest.version;
    inherit src bunDeps;
    nativeBuildInputs = [bun bun2nix.hook makeWrapper];
    bunRoot = ".";
    # Stripping a Bun executable would remove its embedded program and assets.
    dontFixup = true;
    doCheck = false;
    buildPhase = ''
      runHook preBuild
      bun run build
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      install -Dm755 dist/allgather "$out/bin/allgather"
      install -Dm755 dist/allgather-server "$out/bin/allgather-server"
      install -Dm644 LICENSE "$out/share/licenses/allgather/LICENSE"
      wrapProgram "$out/bin/allgather" --prefix PATH : ${lib.makeBinPath [git openssh]}
      wrapProgram "$out/bin/allgather-server" --prefix PATH : ${lib.makeBinPath [git openssh]}
      runHook postInstall
    '';
    meta = {
      description = "Single-owner task server, Git history, CLI, and MCP";
      platforms = lib.platforms.unix;
      mainProgram = "allgather";
    };
  }
