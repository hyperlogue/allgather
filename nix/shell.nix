{...}: {
  perSystem = {pkgs, ...}: {
    devShells.default = pkgs.mkShell {
      name = "allgather-dev";
      packages = with pkgs; [bun biome allgatherNode (lib.hiPrio allgatherNpm) git gh jq process-compose];
      shellHook = ''
        export ALLGATHER_ROOT_DIR=$PWD
      '';
    };
  };
}
