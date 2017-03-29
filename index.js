const express = require('express');
const app = express();
const GitHub = require('octokat')
const Realm = require('realm');
const path = require('path');
const dateFormat = require('dateformat');
const utilities = require('./utilities');
const config = require('./config/config');

// Realm Model Definition
const TaskSchema = {
  name: 'Task',
  primaryKey: 'id',
  properties: {
    text: 'string', // task title
    start_date:  'date', // the date when a task is scheduled to begin
    duration: 'int', // the task duration
    id: 'int', // the task id
    body: 'string',
    url: 'string',
    html_url: 'string',
    number: 'int',
    // Indicates the state of the issues to return. 
    // Can be either open, closed, or all.
    state: 'string',
    isDeleted: 'bool',
    // the task type, available values are stored in the types object:
    //
    // "task" - a regular task (default value).
    //
    // "project" - a task that starts, when its earliest child task starts, and 
    // ends, when its latest child ends. The start_date, end_date, duration 
    // properties are ignored for such tasks.
    //
    // "milestone" - a zero-duration task that is used to mark out important 
    // dates of the project. The duration, progress, end_date properties are 
    // ignored for such tasks.
    type: {type: 'string', optional: true},
    // the id of the parent task. 
    // The id of the root task is specified by the root_id config
    parent: {type: 'int', optional: true},
    // the task's level in the tasks hierarchy (zero-based numbering).
    level: {type: 'int', optional: true},
    // ( number from 0 to 1 ) the task progress.
    progress: {type: 'double', optional: true},
    // specifies whether the task branch will be opened initially 
    // (to show child tasks).
    open: {type: 'bool', optional: true},
    // the date when a task is scheduled to be completed. Used as an alternative
    // to the duration property for setting the duration of a task.
    end_date: {type: 'date', optional: true},
    // the background color of the task bar
    color: {type: 'string', optional: true},
    // the label used to identify the color of the task
    label: {type: 'string', optional: true},
  }
};

let realm = new Realm({
  path: 'tasks.realm',
  schema: [TaskSchema]
});

const gh = new GitHub({
  token: config.GITHUB_API_TOKEN
});

function processIssues(issues, completion, idArray) {
  if (!utilities.isArray(idArray)) {
    idArray = [];
  }
  
  for (index in issues.items) {
    let issue = issues.items[index];
    var startDate = new Date(issue.createdAt);
    var dueDate = null;
    var label = null;
    var color = null;
    var progress = null;
    
    // find keywords
    if (issue.body != null) {
      var lines = issue.body.split('\r\n')
      for (var j = 0; j < lines.length; j++) {
        if (!lines[j].indexOf(config.START_DATE_STRING)) {
          let date = new Date(lines[j].replace(config.START_DATE_STRING, ''));
          if (utilities.isDate(date)) {
            startDate = date;
          }
        }
        if (!lines[j].indexOf(config.DUE_DATE_STRING)) {
          let date = new Date(lines[j].replace(config.DUE_DATE_STRING, ''));
          if (utilities.isDate(date)) {
            dueDate = date;
          }
        }
        if (!lines[j].indexOf(config.LABEL_STRING)) {
          var labelString = lines[j].replace(config.LABEL_STRING, '');
          if (utilities.isString(labelString)) {
            labelString = labelString.trim();
            if (utilities.isArray(issue.labels)) {
              for (index in issue.labels) {
                let aLabel = issue.labels[index];
                if (aLabel.name == labelString) {
                  label = aLabel.name;
                  if (utilities.isString(aLabel.color)) {
                    color = "#"+aLabel.color.toUpperCase();
                  }
                }
              }
            }
          }
        }
        if (!lines[j].indexOf(config.PROGRESS_STRING)) {
          progress = utilities.sanitizeFloat(lines[j].replace(config.PROGRESS_STRING, ''));
        }
      }
    }
    
    realm.write(() => {
      realm.create('Task', {
        text: utilities.sanitizeStringNonNull(issue.title),
        start_date:  startDate,
        duration: 1,
        id: issue.id,
        body: utilities.sanitizeStringNonNull(issue.body),
        url: utilities.sanitizeStringNonNull(issue.url),
        html_url: utilities.sanitizeStringNonNull(issue.htmlUrl),
        number: issue.number,
        state: issue.state,
        isDeleted: false,
        end_date: dueDate,
        label: label,
        color: color,
        progress: progress,
      }, true);
    });
    
    idArray.push(issue.id);
  }
  
  if (utilities.isString(issues.nextPageUrl)) {
    issues.nextPage.fetch()
    .then((moreIssues) => {
      processIssues(moreIssues, completion, idArray);
    });
  }
  else {
    // Prune the deleted issues
    oldIds = realm.objects('Task').map(function(task) {
      return task.id;
    });
    
    deletedIds = oldIds.filter(function(el) {
      return idArray.indexOf(el) < 0;
    });
    
    realm.write(() => {
      for (index in deletedIds) {
        let deletedId = deletedIds[index];
        let task = realm.objectForPrimaryKey('Task', deletedId);
        task.isDeleted = true;
      }
    });
    
    completion();
  }
}

function getTaskChartData() {
  let tasks = realm.objects('Task').filtered('isDeleted = false AND state = "open" AND end_date != null').sorted('start_date', true).sorted('label');
  var taskData = {data: []};
  for (index in tasks) {
    let task = tasks[index];
    let formattedTask = {
      id: task.id,
      text: task.text,
      start_date: dateFormat(task.start_date, "mm-dd-yyyy"),
      duration: task.duration,
      end_date: dateFormat(task.end_date, "mm-dd-yyyy"),
      url: task.url,
      progress: task.progress,
      color: task.color,
    };
    taskData.data.push(formattedTask);
  }
  
  return taskData;
}

app.use('/static', express.static(path.join(__dirname, 'node_modules/dhtmlx-gantt/codebase')));

app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname+'/index.html'));
});

app.get('/data', function (req, res) {
  var taskData = getTaskChartData();
  res.send(taskData);
});

app.get('/refreshData', function (req, res) {
  gh.repos(config.GITHUB_ORG_NAME, config.GITHUB_REPO_NAME).issues.fetch({state: "all", per_page: 100})
  .then((issues) => {
    processIssues(issues, () => {
      console.log("--> Finished Processing Issues");
      var taskData = getTaskChartData();
      res.send(taskData);
    });
  });
});

app.get('/getIssueURL', function (req, res) {
  let taskId = parseInt(req.query.id);
  let task = realm.objectForPrimaryKey('Task', taskId);
  res.send(task.html_url);
});

app.listen(process.env.PORT || 3000, function () {
  let port = (process.env.PORT || 3000);
  console.log('Github-Gantt listening on port ' + port);
});
