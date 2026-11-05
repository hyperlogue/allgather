# Shared project toolchain, applied in nix/nixpkgs.nix.
final: prev: let
  toolchain = final.callPackage ../toolchain.nix {bun = prev.bun;};
in {
  inherit (toolchain) bun biome;
  allgatherNode = toolchain.node;
  allgatherNpm = toolchain.npm;
}
