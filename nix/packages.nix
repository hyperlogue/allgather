{...}: {
  perSystem = {pkgs, ...}: {
    packages = let
      allgather = pkgs.callPackage ./allgather.nix {};
    in {
      inherit allgather;
      default = allgather;
      inherit (pkgs) bun biome;
      node = pkgs.allgatherNode;
      npm = pkgs.allgatherNpm;
    };
  };
}
