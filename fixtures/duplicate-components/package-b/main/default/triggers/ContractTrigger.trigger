trigger ContractTrigger on Contract (before insert) {
    ApprovalProcessHandler.start();
}
