from typing import Protocol, Mapping, List, Union, Literal, overload

class Srv_l3vpnEntry_ce96e39d(Protocol):
    """
YANG: srv-l3vpn:/srv-l3vpn
description: This is an RFS skeleton service
key: name
"""
    # @yang:file=/Users/cwdavis/scripts/auto-discovery/srv-l3vpn/src/yang/srv-l3vpn.yang line=1
    dummy: str
    """
YANG: srv-l3vpn:/srv-l3vpn/dummy
type: ipv4-address
"""
    # @yang:file=/Users/cwdavis/scripts/auto-discovery/srv-l3vpn/src/yang/srv-l3vpn.yang line=1
    name: str
    """
YANG: srv-l3vpn:/srv-l3vpn/name
type: string
"""
    device: List[str]
    """
YANG: srv-l3vpn:/srv-l3vpn/device
type: leafref (leafref→ /ncs:devices/ncs:device/ncs:name)
"""

class Srv_l3vpnList_2879b2ac(Protocol, Mapping[str, Srv_l3vpnEntry_ce96e39d]):
    @overload
    def create(self, name: str) -> Srv_l3vpnEntry_ce96e39d: ...
    @overload
    def delete(self, name: str) -> None: ...

class Srv_l3vpnModule(Protocol):
    srv_l3vpn: Srv_l3vpnList_2879b2ac
    srv_l3vpn: Srv_l3vpnList_2879b2ac
    list: Srv_l3vpnList_2879b2ac
