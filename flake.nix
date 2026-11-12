{
  description = "NetStacks Terminal: an AI-powered SSH terminal for network engineers";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: rec {
        netstacks = pkgs.callPackage ./nix/package.nix { };
        default = netstacks;
      });

      overlays.default = final: _: { netstacks = final.callPackage ./nix/package.nix { }; };
    };
}
