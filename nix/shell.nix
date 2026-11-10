{...}: {
  perSystem = {pkgs, ...}: {
    devShells.default = pkgs.mkShell {
      name = "allgather-dev";
      packages = with pkgs; [bun biome allgatherNode (lib.hiPrio allgatherNpm) git gh jq];
      shellHook = ''
        export ALLGATHER_ROOT_DIR=$PWD
      '';
    };
  };
}
