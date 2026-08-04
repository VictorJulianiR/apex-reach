public class TaskHandler {
    public static void createTasks(List<Opportunity> records) {
        List<Task> tasks = new List<Task>();
        for (Opportunity record : records) {
            tasks.add(new Task(WhatId = record.Id, Subject = 'Follow up'));
        }
        insert tasks;
    }
}
