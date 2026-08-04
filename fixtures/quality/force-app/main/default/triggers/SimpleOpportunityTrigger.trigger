trigger SimpleOpportunityTrigger on Opportunity (after insert) {
    TaskHandler.createTasks(Trigger.new);
}
