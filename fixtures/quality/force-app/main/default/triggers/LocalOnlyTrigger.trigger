trigger LocalOnlyTrigger on Lead (before update) {
    LocalOnlyHandler.calculate(Trigger.new);
}
